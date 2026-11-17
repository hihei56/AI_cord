const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { readJson } = require('./jsonFile');
const { isOwnAccount } = require('./ownAccounts');
const humanPresence = require('./humanPresence');

// サーバーに常駐して、bot自身の不具合を見つけて報告する監視役。
//
// 見つけたものは data/bug-reports.jsonl に1行ずつ追記する。GitHub Actions(bug-reports.yml)が
// 定期的にVPSから回収してGitHubのissueにし、Claude Codeの定期タスクがそれを読んで修正する。
// リポジトリは公開なので、報告には人間の発言・ユーザー名・ユーザーID・サーバー/チャンネル名を
// 一切入れない。入れてよいのは、bot自身が既に投稿した発言と、機械的な事実(件数・種類)だけ。
//
// 検出するもの:
//   truncated      : 自分の発言が文の途中で切れている(上限で切られた)
//   foreign-script : 日本語以外の文字(ハングル・キリル・タミル等)が混ざった
//   prompt-leak    : プロンプトの見出し・指示(【…】や「検索:」等)が発言に漏れた
//   talking-to-void: 誰も反応していないのに、同じアカウントが続けて投稿した
//   suspected-bot  : 人間がbotの発言に「bot」「AI」等と反応した(bot臭さを見抜かれた)
//   persona-drift  : 直近の発言が人格設定と食い違う(LLMで定期的に判定)
//   error-repeat   : 同じエラーが短時間に何度も出た
const M = {
  enabled: true,
  flushMinutes: 30,
  personaCheckHours: 6,
  // 同じ種類・アカウントの報告を何件溜まったら出すか(1回きりの偶然は報告しない)
  thresholds: { truncated: 2, 'talking-to-void': 2, 'error-repeat': 5, 'suspected-bot': 1, 'foreign-script': 1, 'prompt-leak': 1, 'persona-drift': 1 },
  ...(config.selfMonitor || {})
};

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const REPORT_FILE = path.join(DATA_DIR, 'bug-reports.jsonl');
const SETTINGS_FILE = path.join(DATA_DIR, 'monitor.json');
const MAX_SAMPLES = 3;
const SAMPLE_MAX_LENGTH = 160;

const settings = readJson(SETTINGS_FILE, { notifyChannelId: null });
// key(種類:アカウント:細目) → { kind, account, detail, count, samples, firstAt }
const pending = new Map();
let clientsRef = [];

function saveSettings() {
  fs.promises
    .mkdir(DATA_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2)))
    .catch((err) => origError('MONITOR', err));
}

function report(kind, account, detail, sample = null) {
  if (!M.enabled) return;
  const key = `${kind}:${account || '-'}:${detail}`;
  const p = pending.get(key) || { kind, account: account || null, detail, count: 0, samples: [], firstAt: Date.now() };
  p.count++;
  if (sample && p.samples.length < MAX_SAMPLES && !p.samples.includes(sample)) p.samples.push(String(sample).slice(0, SAMPLE_MAX_LENGTH));
  pending.set(key, p);
}

// 溜まった報告のうち、閾値を超えたものをファイルに書き出す(と、設定されていればDiscordにも出す)
function flush() {
  const ready = [];
  for (const [key, p] of pending) {
    if (p.count >= (M.thresholds[p.kind] || 1)) {
      ready.push({ ...p, at: Date.now() });
      pending.delete(key);
    } else if (Date.now() - p.firstAt > 24 * 3600000) {
      pending.delete(key);
    }
  }
  if (ready.length === 0) return ready;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(REPORT_FILE, ready.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } catch (err) {
    origError('MONITOR', err);
  }
  logger.log('MONITOR', `不具合を${ready.length}件記録: ${ready.map((r) => `${r.kind}(${r.account || '-'})×${r.count}`).join(', ')}`);
  notify(ready).catch((err) => origError('MONITOR', err));
  return ready;
}

async function notify(ready) {
  if (!settings.notifyChannelId) return;
  const client = clientsRef.find((c) => c.user && c.channels.cache.get(settings.notifyChannelId));
  const channel = client?.channels.cache.get(settings.notifyChannelId);
  if (!channel) return;
  const lines = ready.map((r) => `・${r.kind} [${r.account || '-'}] ${r.detail} ×${r.count}${r.samples[0] ? `\n　例: ${r.samples[0].slice(0, 80)}` : ''}`);
  await channel.send(`🛠️ 不具合を見つけた(自動でissue化して直す)\n${lines.join('\n')}`.slice(0, 1900));
}

// ── 自分の発言のチェック ──
const FOREIGN_SCRIPT_RE = /[Ѐ-ӿ฀-๿ऀ-ॿ가-힯ᄀ-ᇿ㄰-㆏؀-ۿ֐-׿஀-௿ঀ-৿]/;
const PROMPT_LEAK_RE = /【[^】]{2,20}】|^\s*(検索|言う中身|返信|発言)\s*[:：]|SKIP|<\/?think>|\bassistant\b/i;
// 文が続いているはずの終わり方(助詞・連用形の「て」「で」等)で、上限近くまで長い
const DANGLING_END_RE = /(て|で|が|を|に|は|と|の|も|や|へ|から|けれど|ので|って|たり|ながら)$/;

function checkOwnMessage(msg, client) {
  const text = msg.content || '';
  const account = client.accountState?.id;
  if (!text || text.startsWith(config.controlPrefix || 'ai!')) return;
  const limit = config.ai?.reply?.maxReplyLength || 60;
  if (text.length >= limit * 0.85 && DANGLING_END_RE.test(text.trim()) && !/\s/.test(text.slice(-3))) {
    report('truncated', account, '発言が文の途中で切れている', text);
  }
  if (!client.accountState?.replyLanguage && FOREIGN_SCRIPT_RE.test(text)) report('foreign-script', account, '日本語以外の文字が混ざった', text);
  if (PROMPT_LEAK_RE.test(text)) report('prompt-leak', account, 'プロンプトの見出しや指示が発言に漏れた', text);

  // 同じチャンネルで、この発言の直前の発言も自分で、間に誰の発言も無い(=反応ゼロのまま重ねた)
  const prev = [...msg.channel.messages.cache.values()]
    .filter((m) => m.id !== msg.id && m.createdTimestamp <= msg.createdTimestamp)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
  if (prev && prev.author.id === msg.author.id && msg.createdTimestamp - prev.createdTimestamp > 10 * 60000 && !msg.reference) {
    report('talking-to-void', account, '誰も反応していないのに同じアカウントが続けて投稿した', text);
  }
}

// 人間がbotの発言に返信・メンションして、bot扱いする言葉を言った
const BOT_SUSPICION_RE = /(\bbot\b|ボット|ﾎﾞｯﾄ|\bai\b|ＡＩ|エーアイ|chat ?gpt|gpt|自動応答|機械みたい|ロボット|中の人)/i;

function checkHumanMessage(msg, client) {
  if (!humanPresence.isHuman(msg)) return;
  const repliedTo = msg.mentions?.repliedUser?.id;
  const toUs = (repliedTo && isOwnAccount(repliedTo)) || msg.mentions?.users?.some?.((u) => isOwnAccount(u.id));
  if (!toUs) return;
  const m = (msg.content || '').match(BOT_SUSPICION_RE);
  // 人間の発言そのものは公開issueに載せない。どの言葉に反応したかと、言われた側の発言だけ残す
  if (m) {
    const target = repliedTo ? msg.channel.messages.cache.get(msg.reference?.messageId)?.content : null;
    report('suspected-bot', client.accountState?.id, `人間に「${m[1].toLowerCase()}」と言われた(bot臭さを見抜かれた可能性)`, target);
  }
}

// ── エラーの監視 ──
const origError = logger.error;
function sanitizeError(text) {
  return String(text)
    .replace(/#[^\s)]+/g, '#ch')
    .replace(/「[^」]*」/g, '「…」')
    .replace(/\d{5,}/g, 'N')
    .replace(/https?:\/\/\S+/g, 'URL')
    .slice(0, 120);
}
function hookErrors() {
  logger.error = (tag, err) => {
    origError(tag, err);
    if (tag === 'MONITOR') return;
    report('error-repeat', null, `[${tag}] ${sanitizeError(err?.message || err)}`);
  };
}

// ── 人格のブレの定期判定 ──
const DRIFT_SAMPLE = 8;
async function checkPersonaDrift() {
  const { callChatCompletion } = require('./aiClient');
  const usageLedger = require('./usageLedger');
  for (const client of clientsRef) {
    const st = client.accountState;
    const recent = (st?.recentReplies || []).slice(-DRIFT_SAMPLE);
    if (!st?.persona || recent.length < 4 || st.replyLanguage) continue;
    const prompt =
      `次の【人格設定】のキャラが、Discordで実際に投稿した【発言】がある。人格設定(口調・語尾・一人称・スタンス・絵文字の有無・長さ)と明らかに食い違う発言だけを選ぶ。\n` +
      `少しのブレや、人格設定に書かれていない話題は問題にしない。別人が書いたように見えるものだけを選ぶ。\n` +
      `出力: 食い違う発言の番号と短い理由を「番号|理由」で1行ずつ。無ければ「なし」とだけ。\n\n` +
      `【人格設定】\n${st.persona.slice(0, 1500)}\n\n【発言】\n${recent.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
    try {
      const out = await usageLedger.runBackground(() =>
        callChatCompletion([{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens: 400, kind: 'think', logTag: 'MONITOR' })
      );
      if (!out || /^\s*なし/.test(out)) continue;
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*(\d+)\s*[|｜:：.]\s*(.+)$/);
        const post = m && recent[Number(m[1]) - 1];
        if (post) report('persona-drift', st.id, `人格設定(${st.personaName || '不明'})と食い違う発言: ${m[2].trim().slice(0, 60)}`, post);
      }
    } catch (err) {
      origError('MONITOR', err);
    }
  }
}

function register(clients) {
  if (!M.enabled) return;
  clientsRef = clients;
  hookErrors();
  for (const client of clients) {
    client.on('messageCreate', (msg) => {
      try {
        if (!msg.guild) return;
        if (msg.author.id === client.user?.id) checkOwnMessage(msg, client);
        // 人間の発言のチェックは1アカウント分だけで足りる(全アカウントが同じ発言を受信するため)
        else if (client === clients.find((c) => c.user && c.guilds.cache.has(msg.guild.id))) checkHumanMessage(msg, client);
      } catch (err) {
        origError('MONITOR', err);
      }
    });
  }
  setInterval(flush, M.flushMinutes * 60000).unref();
  setInterval(() => checkPersonaDrift().catch((err) => origError('MONITOR', err)), M.personaCheckHours * 3600000).unref();
}

module.exports = {
  register,
  report,
  flush,
  checkOwnMessage,
  checkHumanMessage,
  checkPersonaDrift,
  pendingCount: () => pending.size,
  setNotifyChannel(id) {
    settings.notifyChannelId = id;
    saveSettings();
  },
  notifyChannelId: () => settings.notifyChannelId,
  REPORT_FILE
};
