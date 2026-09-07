const config = require('../utils/config');
const logger = require('../utils/logger');
const { generateSelfTalk, getAIResponse, recordReply } = require('../utils/aiClient');
const { scheduleWithJitter } = require('../utils/scheduler');
const { isOwnAccount } = require('../utils/ownAccounts');

const {
  checkIntervalMs: CHECK_INTERVAL_MS,
  checkIntervalJitter: CHECK_INTERVAL_JITTER = 0.4,
  alwaysOn: ALWAYS_ON,
  alwaysOnIntervalMs: ALWAYS_ON_INTERVAL_MS,
  quietThresholdMs: QUIET_THRESHOLD_MS = 600000,
  triggerChance: TRIGGER_CHANCE,
  minTurns: MIN_TURNS,
  maxTurns: MAX_TURNS,
  continueChance: CONTINUE_CHANCE,
  turnDelayMinMs: TURN_DELAY_MIN_MS,
  turnDelayMaxMs: TURN_DELAY_MAX_MS
} = config.conversationSeed;

// 本物のユーザー(botでも自アカウント群でもない)の発言か
function isRealUserMessage(msg) {
  return !msg.author.bot && !isOwnAccount(msg.author.id);
}

// チャンネルが「盛り上げ対象」かどうか。直近の発言(誰のものでも良い)が
// quietThresholdMs以上前なら対象。誰も一度も発言していない完全な無人チャンネルこそ
// 最優先で賑やかすべき対象なので、「直近の発言が見つからない」場合もtrue扱いにする
// (以前の実装は「人間の発言が見つからない」場合をfalse=対象外にしてしまっており、
// 一番賑やかしたい無人チャンネルが逆に除外されるバグだった)
async function isChannelQuiet(channel) {
  try {
    const recent = await channel.messages.fetch({ limit: 1 });
    const last = recent.first();
    if (!last) return true;
    return Date.now() - last.createdTimestamp > QUIET_THRESHOLD_MS;
  } catch {
    return false;
  }
}

function pickPair(clients) {
  const shuffled = [...clients].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
}

function sharedChannels(clientA, clientB) {
  return clientA.accountState.channelStore
    .listChannels()
    .filter((id) => clientB.accountState.channelStore.isAllowedChannel(id));
}

function randomTurnCount() {
  return MIN_TURNS + Math.floor(Math.random() * (MAX_TURNS - MIN_TURNS + 1));
}

function turnDelay() {
  return TURN_DELAY_MIN_MS + Math.random() * (TURN_DELAY_MAX_MS - TURN_DELAY_MIN_MS);
}

// sinceTimestamp以降に人間の発言が無いか確認する(掛け合いの途中でユーザーが
// 割り込んできたら打ち切って人間の話に譲るため)
async function humanInterruptedSince(client, channelId, sinceTimestamp) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return false;
  try {
    const recent = await channel.messages.fetch({ limit: 5 });
    return [...recent.values()].some((m) => m.createdTimestamp > sinceTimestamp && isRealUserMessage(m));
  } catch {
    return false;
  }
}

// 過疎ぎみのチャンネルでAI同士に何度か掛け合いをさせて連投気味に会話を起こす。
// 通常のmessageCreateトリガーは経由しない(お互いに際限なく反応し合うのを防ぐため)。
// 途中でユーザーが発言してきたら打ち切り、通常のmessageHandler(人間には普通に反応する)に譲る
async function seedConversation(clientA, clientB, channelId) {
  const channelA = clientA.channels.cache.get(channelId);
  if (!channelA) return;

  const opener = await generateSelfTalk(clientA.accountState);
  if (!opener) return;

  await channelA.send(opener);
  recordReply(clientA.accountState, opener);
  logger.log('SEED', `[${clientA.accountState.id}] ${opener}`);

  const history = [{ author: { username: clientA.user.username }, content: opener }];
  let speaker = clientB;
  let listener = clientA;
  let lastMsg = opener;
  let lastActionAt = Date.now();

  const totalTurns = randomTurnCount();

  for (let turn = 1; turn < totalTurns; turn++) {
    if (speaker.accountState.lockedDown) break;

    await new Promise((r) => setTimeout(r, turnDelay()));

    if (await humanInterruptedSince(speaker, channelId, lastActionAt)) {
      logger.log('SEED', `[${speaker.accountState.id}] ユーザーの発言を検知したため掛け合いを中断`);
      break;
    }

    // 相手(listener)は人間ではなく別のAIアカウントなので、それをプロンプトに明示する
    const reply = await getAIResponse(speaker.accountState, lastMsg, history, null, {
      partnerIsAi: true,
      speakerLabelOverride: listener.user.username
    });
    if (!reply) break;

    const channel = speaker.channels.cache.get(channelId);
    if (!channel) break;

    await channel.send(reply);
    recordReply(speaker.accountState, reply);
    logger.log('SEED', `[${speaker.accountState.id}] ${reply}`);

    history.push({ author: { username: speaker.user.username }, content: reply });
    lastMsg = reply;
    lastActionAt = Date.now();

    [speaker, listener] = [listener, speaker];

    // 最低ターン数を超えたら確率で切り上げる(毎回律儀に上限まで続くと不自然)
    if (turn + 1 >= MIN_TURNS && Math.random() > CONTINUE_CHANCE) break;
  }
}

// AIだけで常時チャットを動かす(config/settings.jsonのconversationSeed.alwaysOn)モード。
// 有効な場合、trigger確率・過疎チェックを無視して、より短い間隔(alwaysOnIntervalMs)で
// 必ず誰かのペアがどこかのチャンネルで会話を始める
function registerConversationSeedHandler(clients) {
  if (clients.length < 2) return;

  const intervalMs = ALWAYS_ON ? ALWAYS_ON_INTERVAL_MS || CHECK_INTERVAL_MS : CHECK_INTERVAL_MS;

  // setIntervalの完全固定周期だとチェックタイミングが規則的になるため、
  // ここも毎回ランダムな待機時間で次回をスケジュールする
  scheduleWithJitter(intervalMs, CHECK_INTERVAL_JITTER, async () => {
    if (!ALWAYS_ON && Math.random() > TRIGGER_CHANCE) return;

    const [clientA, clientB] = pickPair(clients);
    if (!clientA?.user || !clientB?.user) return;
    if (clientA.accountState.lockedDown || clientB.accountState.lockedDown) return;

    const channels = sharedChannels(clientA, clientB);
    for (const channelId of channels) {
      const channel = clientA.channels.cache.get(channelId);
      if (!channel) continue;
      if (ALWAYS_ON || (await isChannelQuiet(channel))) {
        try {
          await seedConversation(clientA, clientB, channelId);
        } catch (err) {
          logger.error('SEED', err);
        }
        break;
      }
    }
  });
}

module.exports = { registerConversationSeedHandler };
