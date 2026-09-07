const logger = require('../utils/logger');
const store = require('../utils/slashBumpStore');

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

// 対象チャンネルにアクセスできる(そのギルドに参加している)最初のアカウントを使う。
// bumpするチャンネルは通常の会話チャンネルと別の場合もあるため、channelStoreには依らない
function findClientForChannel(clients, channelId) {
  return clients.find((c) => c.channels?.cache.get(channelId));
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

  try {
    const channel = client.channels.cache.get(target.channelId);
    await channel.sendSlash(target.botId, target.command);
    logger.log('SLASHBUMP', `[${target.name}] /${target.command} を ${channel.name ?? target.channelId} に送信`);
  } catch (err) {
    logger.error('SLASHBUMP', err);
  }
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
    logger.error('SLASHBUMP', err);
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
    await executeBump(clients, target);
    scheduleNextBump(clients, target);
  }, delay);
}

// 対象BOTからの応答を見て成功/クールダウンを判定し、次回実行時刻を調整する
function handleBumpResponse(clients, msg) {
  const targets = store.getTargets().filter((t) => t.botId === msg.author.id && t.channelId === msg.channel.id);
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

// この対象の自動実行ループを開始する(起動時、および!slashbump add実行時に呼ぶ)
function startTarget(clients, target) {
  executeBump(clients, target).then(() => scheduleNextBump(clients, target));
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
  startTarget: (target) => startTarget(clientsRef || [], target),
  stopTarget,
  forceBump
};
