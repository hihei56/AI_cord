const fs = require('fs');
const path = require('path');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { isOwnAccount } = require('../utils/ownAccounts');
const { todayJST, hourOfDayJST } = require('../utils/datetime');
const serverStats = require('../utils/serverStats');
const usageLedger = require('../utils/usageLedger');
const { callChatCompletion } = require('../utils/aiClient');

// サーバー活性化コーチ: 週1回、サーバー全体の統計(serverStats)から問題を検出し、
// LLMに「問題の具体化(なぜ起きていそうか)」と「解決策(構造整理・客引き・
// イベント・運営・AIの使い方)」を出させて、指定チャンネルにレポートを投稿する。
//
// 問題の検出はLLMではなく数値のしきい値で行う。LLMに統計を丸投げして「問題を
// 見つけて」と頼むと、どのサーバーにも当てはまる一般論(「イベントを開きましょう」)
// しか出てこず、根拠の数字も出てこないため。LLMは検出済みの問題+数字を受け取り、
// その具体化と打ち手の提案だけを担当する。LLMが失敗しても数値部分のレポートは出す。
// 前回のレポートで出した問題を覚えておき、次回「改善したか」を数字で追う。

const COACH = {
  enabled: true,
  reportWeekday: 1, // 0=日曜。既定は月曜
  reportHourJST: 21,
  maxTokens: 1800,
  ...(config.serverCoach || {})
};

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'server-coach.json');
let store;
try {
  store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
} catch {
  store = {};
}
store.guilds = store.guilds || {};

function saveStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function guildConf(guildId) {
  return (store.guilds[guildId] = store.guilds[guildId] || { channelId: null, lastReportDate: null, lastProblems: {} });
}

const pct = (x) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);
const num = (x, d = 1) => (x === null || x === undefined ? '-' : Number(x).toFixed(d));

function textChannels(guild) {
  return [...guild.channels.cache.values()].filter((c) => c.type === 'GUILD_TEXT' && c.viewable !== false);
}

// しきい値による問題検出。valueは次回の比較用(改善したか)に保存する
function detectProblems(m, guild) {
  const problems = [];
  const add = (id, category, title, evidence, value) => problems.push({ id, category, title, evidence, value });

  if (m.prevMessagesPerDay) {
    const change = m.messagesPerDay / m.prevMessagesPerDay - 1;
    if (change <= -0.2) add('decline', '活性度', '発言数が減っている', `1日あたり発言数 ${num(m.prevMessagesPerDay)}→${num(m.messagesPerDay)}(${pct(change)})`, m.messagesPerDay);
  }
  if (m.weeklyActive >= 5 && m.top3Share >= 0.5) {
    add('concentration', '構造', '少数の常連に依存している', `上位3人が人間の発言の${pct(m.top3Share)}を占める(週の発言者${m.weeklyActive}人)`, m.top3Share);
  }
  if (m.retention !== null && m.prevWeeklyActive >= 5 && m.retention < 0.5) {
    add('retention', '定着', '先週喋った人が今週戻ってこない', `先週の発言者${m.prevWeeklyActive}人のうち今週も発言したのは${pct(m.retention)}`, m.retention);
  }
  if (m.joins === 0) {
    add('noInflow', '客引き', '新規参加がない', '直近7日の参加者0人(参加通知メッセージの数で計測)', 0);
  }
  if (m.newcomerSample >= 3 && m.newcomerPostRate !== null && m.newcomerPostRate < 0.3) {
    add('silentNewcomers', '定着', '新規参加者が一言も喋らない', `参加から7日以上経った新規${m.newcomerSample}人のうち発言したのは${pct(m.newcomerPostRate)}`, m.newcomerPostRate);
  }
  if (m.newcomerRespondedRate !== null && m.newcomerRespondedRate < 0.7) {
    add('ignoredNewcomers', '定着', '新規の最初の発言が放置されている', `新規の初発言のうち30分以内に誰かが反応したのは${pct(m.newcomerRespondedRate)}`, m.newcomerRespondedRate);
  }
  if (m.aiShare > 0.3) {
    add('aiHeavy', 'AIの使い方', 'AIの発言が多すぎる', `全発言のうちAI(自分たちのアカウント)が${pct(m.aiShare)}`, m.aiShare);
  }

  const channels = textChannels(guild);
  if (channels.length >= 4 && m.daysCovered >= 7) {
    const dead = channels.filter((c) => !m.channels[c.id]);
    if (dead.length / channels.length >= 0.4) {
      add('deadChannels', '構造', '使われていないチャンネルが多い', `テキストチャンネル${channels.length}個中${dead.length}個で直近7日の人間の発言が0(${dead.slice(0, 8).map((c) => `#${c.name}`).join(' ')}${dead.length > 8 ? ' 他' : ''})`, dead.length / channels.length);
    }
    const sorted = Object.entries(m.channels).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((a, [, n]) => a + n, 0);
    if (total > 0 && sorted[0][1] / total >= 0.8 && channels.length >= 6) {
      const name = guild.channels.cache.get(sorted[0][0])?.name || sorted[0][0];
      add('oneChannel', '構造', '会話が1チャンネルに集中し、他が飾りになっている', `#${name}が人間の発言の${pct(sorted[0][1] / total)}`, sorted[0][1] / total);
    }
  }
  return problems;
}

// 前回のレポートで出した問題が今回どうなったか(数字で追う)
function followUp(conf, problems) {
  const lines = [];
  const now = Object.fromEntries(problems.map((p) => [p.id, p]));
  for (const [id, prev] of Object.entries(conf.lastProblems || {})) {
    if (now[id]) lines.push(`・${prev.title}: 継続中(前回 ${num(prev.value, 2)} → 今回 ${num(now[id].value, 2)})`);
    else lines.push(`・${prev.title}: しきい値を下回り解消`);
  }
  return lines;
}

function metricsBlock(m, guild) {
  const topHours = m.hours
    .map((n, h) => [h, n])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .filter(([, n]) => n > 0)
    .map(([h]) => `${h}時`)
    .join('・');
  const topChannels = Object.entries(m.channels)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, n]) => `#${guild.channels.cache.get(id)?.name || id}(${n})`)
    .join(' ');
  return [
    `1日あたり発言数: ${num(m.messagesPerDay)}(前週 ${num(m.prevMessagesPerDay)})`,
    `1日あたり発言者数: ${num(m.avgDailyActive)} / 週の発言者数: ${m.weeklyActive}(前週 ${m.prevWeeklyActive ?? '-'})`,
    `先週からの定着率: ${pct(m.retention)} / 上位3人の発言シェア: ${pct(m.top3Share)}`,
    `リプライ率: ${pct(m.replyRate)} / AIの発言シェア: ${pct(m.aiShare)}`,
    `新規参加: ${m.joins}人 / 新規の発言率: ${pct(m.newcomerPostRate)} / 新規の初発言への反応率: ${pct(m.newcomerRespondedRate)}`,
    `よく喋られる時間帯: ${topHours || '-'} / よく使われるチャンネル: ${topChannels || '-'}`
  ].join('\n');
}

async function proposeSolutions(guild, m, problems) {
  const prompt =
    `あなたはDiscordコミュニティ運営のアドバイザー。サーバー「${guild.name}」の直近7日の統計と、数値から検出された問題を渡す。\n` +
    `【統計】\n${metricsBlock(m, guild)}\n` +
    `【検出された問題】\n${problems.map((p, i) => `${i + 1}. [${p.category}] ${p.title}: ${p.evidence}`).join('\n')}\n\n` +
    '各問題について、次の3つを日本語で簡潔に書くこと。\n' +
    '1) 具体化: この数字から考えられる原因の仮説(断定せず「〜の可能性」と書く。数字に無いことを事実のように書かない)\n' +
    '2) 打ち手: 来週すぐ実行できる具体的な行動を2つまで(例: どのチャンネルを統合/アーカイブするか、何曜何時に何をするか、新規の初発言に誰がどう反応するか)。一般論(「イベントを開こう」だけ等)は禁止\n' +
    '3) 測り方: 打ち手が効いたかを上の統計のどの数字で判断するか\n' +
    '制約: 特定の個人を名指しで評価・批判しない。客引きは掲載サイト(DISBOARD等)・SNSでの告知・既存メンバーの招待など各サービスの規約内の方法に限り、他サーバーやDMへの無差別な宣伝は提案しない(スパム扱いでBANされるため)。' +
    'AIアカウントの使い方を提案する場合は、AIだけで会話を埋めるのではなく人間が入りやすくする方向にする。\n' +
    '見出しは「■問題名」とし、前置き・まとめは書かない。';

  return usageLedger.runBackground(() =>
    callChatCompletion([{ role: 'user', content: prompt }], {
      temperature: 0.4,
      maxTokens: COACH.maxTokens,
      kind: 'seed',
      logTag: 'COACH'
    })
  );
}

function chunk(text, size = 1900) {
  const out = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if ((buf + '\n' + line).length > size) {
      if (buf) out.push(buf);
      buf = line.slice(0, size);
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// 宣伝RPCのボタンに載せた招待リンクの使用回数(=宣伝経由で入った人数の上限)。
// 招待の使用数の取得には「サーバー管理」権限が要るので、取れない時はnull
async function promoInviteUses(guild) {
  const url = process.env.PROMO_INVITE_URL || config.promo?.inviteUrl;
  const code = url?.match(/(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]+)/)?.[1];
  if (!code) return null;
  try {
    const invites = await guild.invites.fetch();
    return invites.get(code)?.uses ?? null;
  } catch {
    return null;
  }
}

async function buildReport(guild, { save = true } = {}) {
  serverStats.flushAll();
  const m = serverStats.computeMetrics(guild.id);
  if (!m) return '📊 まだ統計がありません(収集を始めてから1日以上待ってください)';

  const conf = guildConf(guild.id);
  const problems = detectProblems(m, guild);
  const follow = followUp(conf, problems);

  const parts = [`📊 **サーバー活性化レポート**(直近${m.daysCovered}日分${m.daysCovered < 7 ? '、データ不足のため参考値' : ''})`, metricsBlock(m, guild)];
  const uses = await promoInviteUses(guild);
  if (uses !== null) {
    const delta = conf.lastPromoInviteUses !== undefined ? uses - conf.lastPromoInviteUses : null;
    parts.push(`宣伝RPCの招待リンク: 累計${uses}回使用${delta !== null ? `(前回レポートから+${delta})` : ''}`);
    if (save) conf.lastPromoInviteUses = uses;
  }
  if (follow.length) parts.push(`\n**前回指摘した問題の経過**\n${follow.join('\n')}`);

  if (problems.length === 0) {
    parts.push('\n**検出された問題**: なし(しきい値を超えた指標はありません)');
  } else {
    parts.push(`\n**検出された問題**\n${problems.map((p) => `・[${p.category}] ${p.title} — ${p.evidence}`).join('\n')}`);
    const proposal = await proposeSolutions(guild, m, problems);
    parts.push(proposal ? `\n**具体化と打ち手**\n${proposal}` : '\n(打ち手の提案はAIの呼び出しに失敗したため省略)');
  }

  if (save) {
    conf.lastProblems = Object.fromEntries(problems.map((p) => [p.id, { title: p.title, value: p.value }]));
    conf.lastReportDate = todayJST();
    saveStore();
  }
  return parts.join('\n');
}

async function sendReport(channel, text) {
  for (const part of chunk(text)) await channel.send(part);
}

// 投稿先チャンネル: !coach channel で設定したもの、無ければ.envのSERVER_COACH_CHANNEL_ID
function reportChannelId(guildId) {
  return guildConf(guildId).channelId || process.env.SERVER_COACH_CHANNEL_ID || null;
}

function registerServerCoachHandler(clients) {
  if (!COACH.enabled) return;

  for (const client of clients) {
    client.on('messageCreate', (msg) => {
      if (!msg.guild || !client.accountState.guildStore.isAllowedGuild(msg.guild.id)) return;
      const isOwn = isOwnAccount(msg.author.id) || msg.author.id === client.user?.id;
      const isHuman = !isOwn && (!msg.author.bot || Boolean(msg.webhookId));
      serverStats.recordMessage(msg, { isOwn, isHuman });
    });
  }

  // 1時間ごとに「今日が報告曜日・報告時刻を過ぎた・今日まだ出していない」を確認する
  setInterval(async () => {
    const now = new Date();
    const weekday = new Date(now.getTime() + 9 * 3600000).getUTCDay(); // 日本時間の曜日(0=日)
    if (weekday !== COACH.reportWeekday || hourOfDayJST(now) < COACH.reportHourJST) return;

    const done = new Set();
    for (const client of clients) {
      if (!client.user) continue;
      for (const guild of client.guilds.cache.values()) {
        if (done.has(guild.id) || !client.accountState.guildStore.isAllowedGuild(guild.id)) continue;
        const channelId = reportChannelId(guild.id);
        const channel = channelId && client.channels.cache.get(channelId);
        if (!channel || guildConf(guild.id).lastReportDate === todayJST()) continue;
        done.add(guild.id);
        try {
          await sendReport(channel, await buildReport(guild));
          logger.log('COACH', `${guild.name}のレポートを投稿`);
        } catch (err) {
          logger.error('COACH', err);
        }
      }
    }
  }, 3600000).unref();
}

module.exports = { registerServerCoachHandler, buildReport, sendReport, guildConf, saveStore, reportChannelId, COACH };
