const config = require('../utils/config');
const logger = require('../utils/logger');
const { fetchRandomGif } = require('../utils/tenorGif');
const { scheduleWithJitter } = require('../utils/scheduler');

// selfTalk/conversationSeedのGIF混在(config.gif.chance等)は「たまに」の演出用だが、
// selfTalk.enabledがfalseだと一切発火しない・複数アカウント運用でないと
// conversationSeed側も発火しないため、「アカウント1つでも定期的に必ず投稿する」
// 用途には向かない。こちらはgifGenres設定済みのアカウントだけを対象に、
// LLMも他機能の有効/無効も一切関係なく単独で一定間隔ごとに投稿する
async function gifPost(client) {
  const state = client.accountState;
  if (state.lockedDown) return;
  // gifGenresは!gifgenreコマンドで実行中に増減しうる配列なので、登録時点ではなく
  // 投稿しようとするたびに空かどうかを確認する
  if (state.gifGenres.length === 0) return;

  const ids = state.channelStore.listChannels();
  if (ids.length === 0) return;
  const channelId = ids[Math.floor(Math.random() * ids.length)];
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  const genre = state.gifGenres[Math.floor(Math.random() * state.gifGenres.length)];
  try {
    const url = await fetchRandomGif(genre);
    if (!url) return;
    await channel.send(url);
    logger.log('GIF', `[${state.id}] (${genre}) ${url}`);
  } catch (err) {
    logger.error('GIF', err);
  }
}

// config.gif.postIntervalMsごとにジッター付きで自動投稿する。起動時点で
// gifGenresが空でも登録自体は行う(!gifgenreコマンドで後からキーワードを
// 追加した時に再起動なしで拾えるようにするため。実際に投稿するかどうかは
// gifPost側でその都度gifGenresの中身を見て判断する)
function registerGifPostHandler(client) {
  if (!config.gif?.postIntervalMs) return;

  const { postIntervalMs, postIntervalJitter = 0.4 } = config.gif;
  scheduleWithJitter(postIntervalMs, postIntervalJitter, () => gifPost(client));
}

module.exports = { registerGifPostHandler };
