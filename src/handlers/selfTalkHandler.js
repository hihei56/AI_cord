const { MessageAttachment } = require('discord.js-selfbot-v13');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { generateSelfTalk, recordReply } = require('../utils/aiClient');
const { getAnimalImage } = require('../utils/animalImage');
const { tryFetchGenreGif } = require('../utils/klipyGif');
const { scheduleWithJitter } = require('../utils/scheduler');
const { isEmojiGifOnlyMode, pickEmojiOrGif } = require('../utils/emojiGifReply');

async function selfPost(channel, accountState) {
  if (!channel) return;
  if (Math.random() > config.selfTalk.chance) return;

  // 絵文字/GIFのみモードでは、画像添付やLLMキャプション生成を一切せず、
  // 絵文字かGIFのどちらかを必ず1つ送るだけにする
  if (isEmojiGifOnlyMode()) {
    try {
      const content = await pickEmojiOrGif(accountState, null);
      await channel.send(content);
      logger.log('SELF', content);
    } catch (err) {
      logger.error('SELF', err);
    }
    return;
  }

  // LLM生成のテキストが続くとどうしてもぎこちなくなりがちなので、
  // アカウントにGIF_GENRE[_N]の設定があれば一定確率でKlipy検索したGIFを
  // キャプション無しでそのまま貼るだけの投稿にする(LLM呼び出し自体をしない)
  const gifUrl = await tryFetchGenreGif(accountState, config.gif?.chance, config.gif?.chanceJitter);
  if (gifUrl) {
    try {
      await channel.send(gifUrl);
      logger.log('SELF', `(GIF) ${gifUrl}`);
      return;
    } catch (err) {
      logger.error('SELF', err);
    }
  }

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
