const { MessageAttachment } = require('discord.js-selfbot-v13');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { generateSelfTalk, recordReply } = require('../utils/aiClient');
const { getAnimalImage } = require('../utils/animalImage');
const { scheduleWithJitter } = require('../utils/scheduler');

async function selfPost(channel, accountState) {
  if (!channel) return;
  if (Math.random() > config.selfTalk.chance) return;

  const withImage = Math.random() < config.selfTalk.imageChance;

  try {
    if (withImage) {
      const animalTypes = config.selfTalk.animalTypes;
      const query = animalTypes[Math.floor(Math.random() * animalTypes.length)];
      const img = await getAnimalImage(query);
      if (img) {
        const caption = await generateSelfTalk(accountState);
        await channel.send({
          content: caption || '（画像）',
          files: [new MessageAttachment(img)]
        });
        if (caption) recordReply(accountState, caption);
        logger.log('SELF', `${caption || '画像のみ'} (画像)`);
        return;
      }
    }

    const text = await generateSelfTalk(accountState);
    if (text) {
      await channel.send(text);
      recordReply(accountState, text);
      logger.log('SELF', text);
    }
  } catch (err) {
    logger.error('SELF', err);
  }
}

function registerSelfTalkHandler(client) {
  if (!config.selfTalk.enabled) return;

  const state = client.accountState;
  const { intervalMs, intervalJitter = 0.4 } = config.selfTalk;

  // setIntervalの完全固定周期だと投稿タイミングが機械的なパターンになりbotバレしやすい
  // ため、毎回ランダムな待機時間で次回をスケジュールする(基準値の±intervalJitter)
  scheduleWithJitter(intervalMs, intervalJitter, async () => {
    if (state.lockedDown) return;
    const ids = state.channelStore.listChannels();
    if (ids.length === 0) return;
    const channelId = ids[Math.floor(Math.random() * ids.length)];
    const channel = client.channels.cache.get(channelId);
    await selfPost(channel, state);
  });
}

module.exports = { registerSelfTalkHandler, selfPost };
