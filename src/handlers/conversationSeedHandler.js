const config = require('../utils/config');
const logger = require('../utils/logger');
const { generateSelfTalk, getAIResponse } = require('../utils/aiClient');

const {
  checkIntervalMs: CHECK_INTERVAL_MS,
  quietThresholdMs: QUIET_THRESHOLD_MS,
  triggerChance: TRIGGER_CHANCE,
  minTurns: MIN_TURNS,
  maxTurns: MAX_TURNS,
  continueChance: CONTINUE_CHANCE,
  turnDelayMinMs: TURN_DELAY_MIN_MS,
  turnDelayMaxMs: TURN_DELAY_MAX_MS
} = config.conversationSeed;

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

// 過疎ってるチャンネルでAI同士に何度か掛け合いをさせて連投気味に会話を起こす。
// 通常のmessageCreateトリガーは経由しない(お互いに際限なく反応し合うのを防ぐため)。
async function seedConversation(clientA, clientB, channelId) {
  const channelA = clientA.channels.cache.get(channelId);
  if (!channelA) return;

  const opener = await generateSelfTalk(clientA.accountState);
  if (!opener) return;

  await channelA.send(opener);
  logger.log('SEED', `[${clientA.accountState.id}] ${opener}`);

  const history = [{ author: { username: clientA.user.username }, content: opener }];
  let speaker = clientB;
  let listener = clientA;
  let lastMsg = opener;

  const totalTurns = randomTurnCount();

  for (let turn = 1; turn < totalTurns; turn++) {
    if (speaker.accountState.lockedDown) break;

    await new Promise((r) => setTimeout(r, turnDelay()));

    const reply = await getAIResponse(speaker.accountState, lastMsg, history);
    if (!reply) break;

    const channel = speaker.channels.cache.get(channelId);
    if (!channel) break;

    await channel.send(reply);
    logger.log('SEED', `[${speaker.accountState.id}] ${reply}`);

    history.push({ author: { username: speaker.user.username }, content: reply });
    lastMsg = reply;

    [speaker, listener] = [listener, speaker];

    // 最低ターン数を超えたら確率で切り上げる(毎回律儀に上限まで続くと不自然)
    if (turn + 1 >= MIN_TURNS && Math.random() > CONTINUE_CHANCE) break;
  }
}

function registerConversationSeedHandler(clients) {
  if (clients.length < 2) return;

  setInterval(async () => {
    if (Math.random() > TRIGGER_CHANCE) return;

    const [clientA, clientB] = pickPair(clients);
    if (!clientA?.user || !clientB?.user) return;
    if (clientA.accountState.lockedDown || clientB.accountState.lockedDown) return;

    const channels = sharedChannels(clientA, clientB);
    for (const channelId of channels) {
      const channel = clientA.channels.cache.get(channelId);
      if (!channel) continue;
      if (await isChannelQuiet(channel)) {
        try {
          await seedConversation(clientA, clientB, channelId);
        } catch (err) {
          logger.error('SEED', err);
        }
        break;
      }
    }
  }, CHECK_INTERVAL_MS);
}

module.exports = { registerConversationSeedHandler };
