const { AttachmentBuilder } = require('discord.js-selfbot-v13');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { generateSelfTalk } = require('../utils/aiClient');
const { getAnimalImage } = require('../utils/animalImage');

async function selfPost(channel) {
  if (!channel) return;
  if (Math.random() > config.selfTalk.chance) return;

  const withImage = Math.random() < config.selfTalk.imageChance;

  try {
    if (withImage) {
      const animalTypes = config.selfTalk.animalTypes;
      const query = animalTypes[Math.floor(Math.random() * animalTypes.length)];
      const img = await getAnimalImage(query);
      if (img) {
        const caption = await generateSelfTalk();
        await channel.send({
          content: caption || '（画像）',
          files: [new AttachmentBuilder(img)]
        });
        logger.log('SELF', `${caption || '画像のみ'} (画像)`);
        return;
      }
    }

    const text = await generateSelfTalk();
    if (text) {
      await channel.send(text);
      logger.log('SELF', text);
    }
  } catch (err) {
    logger.error('SELF', err);
  }
}

function registerSelfTalkHandler(client) {
  const state = client.accountState;
  setInterval(async () => {
    if (state.lockedDown) return;
    const ids = state.channelStore.listChannels();
    if (ids.length === 0) return;
    const channelId = ids[Math.floor(Math.random() * ids.length)];
    const channel = client.channels.cache.get(channelId);
    await selfPost(channel);
  }, config.selfTalk.intervalMs);
}

module.exports = { registerSelfTalkHandler, selfPost };
