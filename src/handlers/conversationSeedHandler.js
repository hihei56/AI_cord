const logger = require('../utils/logger');
const { generateSelfTalk, getAIResponse } = require('../utils/aiClient');

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10分ごとにチェック
const QUIET_THRESHOLD_MS = 20 * 60 * 1000; // 直近20分以上発言がなければ「静か」
const TRIGGER_CHANCE = 0.3; // チェックのたびに毎回やるとうざいので確率を絞る

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

async function seedConversation(clientA, clientB, channelId) {
  const channelA = clientA.channels.cache.get(channelId);
  const channelB = clientB.channels.cache.get(channelId);
  if (!channelA || !channelB) return;

  const opener = await generateSelfTalk();
  if (!opener) return;

  await channelA.send(opener);
  logger.log('SEED', `[${clientA.accountState.id}] ${opener}`);

  await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000));

  const reply = await getAIResponse(
    clientB.accountState,
    opener,
    [{ author: { username: clientA.user.username }, content: opener }]
  );
  if (!reply) return;

  await channelB.send(reply);
  logger.log('SEED', `[${clientB.accountState.id}] ${reply}`);
}

// 複数アカウントがいる時、チャンネルが静かなら片方が話しかけ、
// もう片方が反応する短い掛け合いを起こして会話を誘発する。
// 通常のmessageCreateトリガーは経由しない(お互いに際限なく反応し合うのを防ぐため)。
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
