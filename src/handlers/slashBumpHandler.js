const logger = require('../utils/logger');
const config = require('../utils/config');
const store = require('../utils/slashBumpStore');
const dailyStore = require('../utils/dailyBumpStore');
const { hourOfDayJST, todayJST } = require('../utils/datetime');

// (botId, channelId)ごとの実行時状態(次回実行タイマー・クールダウン中フラグ・
// 直前の応答メッセージID)。永続化はせず、起動のたびに初期状態から始まる
// (disssokuの元実装と同様、再起動直後は即座に1回実行を試みる)
const runtimeStates = new Map();
let clientsRef = null;

function stateKey(botId, channelId) {
  return `${botId}:${channelId}`;
}

function getState(botId, channelId) {
  const key = stateKey(botId, channelId);
  if (!runtimeStates.has(key)) {
    runtimeStates.set(key, { lastBumped: 0, cooldownActive: false, timer: null, lastProcessedMsgId: null });
  }
  return runtimeStates.get(key);
}

// !slashbump assign でそのサーバーに割り当てたアカウントがあればそれを使い、
// 無ければ対象チャンネルにアクセスできる(そのギルドに参加している)最初のアカウントを使う。
// bumpするチャンネルは通常の会話チャンネルと別の場合もあるため、channelStoreには依らない
function findClientForChannel(clients, channelId) {
  const accessible = clients.filter((c) => c.channels?.cache.get(channelId));
  if (accessible.length === 0) return undefined;

  const guildId = accessible[0].channels.cache.get(channelId).guild?.id;
  const assignedId = guildId ? store.getGuildAccount(guildId) : null;
  if (!assignedId) return accessible[0];

  const assigned = accessible.find((c) => c.accountState?.id === assignedId);
  if (assigned) return assigned;
  logger.error('SLASHBUMP', `サーバー${guildId}の割り当てアカウント${assignedId}が使えないため、アカウント${accessible[0].accountState?.id}で代わりに実行`);
  return accessible[0];
}

// 自動bump実行のたびに、!slashbump notifyで指定した人間のユーザーをメンションして
// bumpを喚起する。毎回同じ文言だと機械的に見えるため、「bump確認してください」を
// ベースにいくつか言い回しを散らす
const BUMP_REMINDER_PHRASES = [
  'bump確認してください',
  'そろそろbumpの時間っぽいので確認お願いします',
  'bumpできてるか確認してもらえますか',
  'bump番、よろしくお願いします',
  'bumpの確認そろそろお願いします〜',
  'bumpのお時間です、確認よろしくです'
];

async function notifyMentionUser(channel, target) {
  if (!channel || !target.mentionUserId) return;
  try {
    const phrase = BUMP_REMINDER_PHRASES[Math.floor(Math.random() * BUMP_REMINDER_PHRASES.length)];
    await channel.send(`<@${target.mentionUserId}> ${phrase}`);
  } catch (err) {
    logger.error('SLASHBUMP', `[${target.name}] メンション通知に失敗: ${err.message}`);
  }
}

async function executeBump(clients, target) {
  const state = getState(target.botId, target.channelId);
  const now = Date.now();
  if (state.cooldownActive || (state.lastBumped > 0 && now - state.lastBumped < 600000)) {
    logger.log('SLASHBUMP', `[${target.name}] スキップ(クールダウン中): ${target.channelId}`);
    return;
  }

  const client = findClientForChannel(clients, target.channelId);
  if (!client) {
    logger.error('SLASHBUMP', `[${target.name}] チャンネル${target.channelId}にアクセスできるアカウントが無い`);
    return;
  }

  const channel = client.channels.cache.get(target.channelId);
  try {
    await channel.sendSlash(target.botId, target.command);
    logger.log('SLASHBUMP', `[${target.name}] /${target.command} を ${channel.name ?? target.channelId} に送信`);
  } catch (err) {
    // エラーメッセージだけだとdata/slash-bump.jsonに複数targetが登録されている時に
    // どれが原因か分からない(実例: botIdがDiscordのスノーフレークID形式になっておらず
    // "Invalid string format"とだけ表示され特定に手間取った)ため、target情報を含める
    logger.error('SLASHBUMP', `[${target.name}] botId=${target.botId} command=${target.command} channelId=${target.channelId}: ${err.message}`);
  } finally {
    // 自動送信が成功しても失敗しても、bumpを試みたタイミング自体は人間に伝える価値が
    // あるため(自動送信がAPI側の都合で失敗した時ほど、人間による手動確認が重要になる)
    await notifyMentionUser(channel, target);
  }
}

// dailyモード(1日1回、日中活動時間帯からランダムな時刻に実行)用。Discord側の
// クールダウンを一切気にせず、mealPostStore.jsと同じ「その日の予定時刻を一度決めたら
// 固定し、過ぎていたら1回だけ実行、実行済みなら次の日まで何もしない」方式で動く
function dailyKey(target) {
  return `${target.botId}:${target.channelId}`;
}

function rollDailyTargetHour(target) {
  const { windowStartHour = 8, windowEndHour = 23 } = config.slashBumpDaily || {};
  const key = dailyKey(target);
  const today = todayJST();
  let hour = dailyStore.getTodayTarget(key, today);
  if (hour === null) {
    hour = windowStartHour + Math.random() * (windowEndHour - windowStartHour);
    dailyStore.setTodayTarget(key, today, hour);
  }
  return hour;
}

// dailyモードはクールダウン判定そのものが不要(1日1回しか呼ばれない前提)なので、
// executeBump()とは別にクールダウンチェック無しの送信だけを行う
async function executeBumpOnce(clients, target) {
  const client = findClientForChannel(clients, target.channelId);
  if (!client) {
    logger.error('SLASHBUMP', `[${target.name}] チャンネル${target.channelId}にアクセスできるアカウントが無い`);
    return;
  }

  const channel = client.channels.cache.get(target.channelId);
  try {
    await channel.sendSlash(target.botId, target.command);
    logger.log('SLASHBUMP', `[${target.name}] (1日1回) /${target.command} を ${channel.name ?? target.channelId} に送信`);
  } catch (err) {
    logger.error('SLASHBUMP', `[${target.name}] botId=${target.botId} command=${target.command} channelId=${target.channelId}: ${err.message}`);
  } finally {
    await notifyMentionUser(channel, target);
  }
}

async function dailyTick(clients, target) {
  const key = dailyKey(target);
  const today = todayJST();
  if (dailyStore.getLastRunDate(key) === today) return; // 今日はもう実行済み

  const targetHour = rollDailyTargetHour(target);
  if (hourOfDayJST() < targetHour) return; // まだ今日の予定時刻前

  // 実行前に先にマークしておく(送信中に次のチェックが割り込んで二重実行するのを防ぐ)
  dailyStore.setLastRunDate(key, today);
  await executeBumpOnce(clients, target);
}

// continuousモードのscheduleNextBumpと同じ、キャンセル可能なsetTimeoutループ。
// runtimeStatesのtimerを共有しているため、stopTarget()はモードを問わず同じ実装で止められる
function scheduleDailyCheck(clients, target) {
  const state = getState(target.botId, target.channelId);
  if (state.timer) clearTimeout(state.timer);

  const { checkIntervalMs = 300000 } = config.slashBumpDaily || {};
  const jitter = checkIntervalMs * 0.2 * (Math.random() * 2 - 1);
  const delay = Math.max(1000, checkIntervalMs + jitter);

  state.timer = setTimeout(async () => {
    await dailyTick(clients, target);
    scheduleDailyCheck(clients, target);
  }, delay);
}

function startDailyTarget(clients, target) {
  // 起動直後にも1回チェックする(今日の予定時刻を既に過ぎていればすぐ実行する)
  dailyTick(clients, target);
  scheduleDailyCheck(clients, target);
}

// 手動実行(!slashbump now)用。クールダウン判定を無視して即座に送信する
async function forceBump(target) {
  if (!clientsRef) return;
  const client = findClientForChannel(clientsRef, target.channelId);
  if (!client) {
    logger.error('SLASHBUMP', `[${target.name}] チャンネル${target.channelId}にアクセスできるアカウントが無い`);
    return;
  }
  try {
    const channel = client.channels.cache.get(target.channelId);
    await channel.sendSlash(target.botId, target.command);
    logger.log('SLASHBUMP', `[${target.name}] (手動)/${target.command} を送信`);
  } catch (err) {
    logger.error('SLASHBUMP', `[${target.name}] botId=${target.botId} command=${target.command} channelId=${target.channelId}: ${err.message}`);
  }
}

// 対象BOTからの応答が来ない場合の既定の次回実行間隔(30〜40分)で次回をスケジュールする。
// クールダウン応答を受け取った場合はhandleBumpResponse側でlastBumpedを調整してから呼ばれる
function scheduleNextBump(clients, target) {
  const state = getState(target.botId, target.channelId);
  if (state.timer) clearTimeout(state.timer);

  const randomInterval = 1_800_000 + Math.random() * 600_000; // 30〜40分
  const now = Date.now();
  const delay = state.lastBumped > now ? state.lastBumped - now : randomInterval;

  state.timer = setTimeout(async () => {
    // このタイマーはクールダウン明け(またはランダム間隔経過後)に再試行するために
    // 予約したものなので、ここでcooldownActiveを解除する。解除しないと
    // executeBump側が毎回cooldownActiveを理由にスキップし続けて実際には
    // コマンドを二度と送信せず、対象Botからの"successfully"応答も二度と
    // 来ないため、cooldownActiveが永久にtrueのまま固まってしまう
    state.cooldownActive = false;
    await executeBump(clients, target);
    scheduleNextBump(clients, target);
  }, delay);
}

// 対象BOTからの応答を見て成功/クールダウンを判定し、次回実行時刻を調整する。
// dailyモードの対象はDiscord側の応答内容に関わらず「1日1回」のスケジュールで
// 動くだけなので、ここでの再スケジュール対象からは除外する(混ざると
// dailyタイマーがcontinuous用のタイマーで上書きされてしまうため)
function handleBumpResponse(clients, msg) {
  const targets = store
    .getTargets()
    .filter((t) => t.botId === msg.author.id && t.channelId === msg.channel.id && t.mode !== 'daily');
  if (targets.length === 0) return;

  const content = msg.content;
  for (const target of targets) {
    const state = getState(target.botId, target.channelId);
    // 同じメッセージを複数アカウントが同時に受信することがあるため、二重処理を防ぐ
    if (state.lastProcessedMsgId === msg.id) continue;
    state.lastProcessedMsgId = msg.id;

    if (/successfully/i.test(content)) {
      state.lastBumped = Date.now();
      state.cooldownActive = false;
      logger.log('SLASHBUMP', `[${target.name}] 成功: ${target.channelId}`);
      scheduleNextBump(clients, target);
    } else if (/(please wait|cooldown|failed|error)/i.test(content)) {
      state.cooldownActive = true;
      const match = content.match(/(\d+)\s*(hours?|days?|minutes?|seconds?)/i);
      let cooldownMs = 900000; // 応答からクールダウン時間を読み取れない場合の既定15分
      if (match) {
        const value = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        cooldownMs = unit.startsWith('hour')
          ? value * 3_600_000
          : unit.startsWith('day')
            ? value * 86_400_000
            : unit.startsWith('minute')
              ? value * 60_000
              : value * 1_000;
      }
      state.lastBumped = Date.now() + cooldownMs + 60_000;
      logger.log('SLASHBUMP', `[${target.name}] クールダウン検知: 次回 ${new Date(state.lastBumped).toLocaleString('ja-JP')}`);
      scheduleNextBump(clients, target);
    }
  }
}

// この対象の自動実行ループを開始する(起動時、!slashbump add/mode実行時に呼ぶ)
function startTarget(clients, target) {
  if (target.mode === 'daily') {
    startDailyTarget(clients, target);
  } else {
    executeBump(clients, target).then(() => scheduleNextBump(clients, target));
  }
}

// この対象の自動実行ループを止める(!slashbump remove実行時に呼ぶ)
function stopTarget(target) {
  const key = stateKey(target.botId, target.channelId);
  const state = runtimeStates.get(key);
  if (state?.timer) clearTimeout(state.timer);
  runtimeStates.delete(key);
}

function registerSlashBumpHandler(clients) {
  clientsRef = clients;

  for (const client of clients) {
    client.on('messageCreate', (msg) => {
      if (!msg.author.bot) return;
      handleBumpResponse(clients, msg);
    });
  }

  for (const target of store.getTargets()) {
    startTarget(clients, target);
  }
}

module.exports = {
  registerSlashBumpHandler,
  getClients: () => clientsRef || [],
  startTarget: (target) => startTarget(clientsRef || [], target),
  stopTarget,
  forceBump
};
