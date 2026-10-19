const config = require('../utils/config');
const logger = require('../utils/logger');
const { generateSelfTalk, recordReply } = require('../utils/aiClient');
const { getRandomHeadline } = require('../utils/newsTopics');
const { scheduleWithJitter } = require('../utils/scheduler');

// gifPostHandler.jsと同じ考え方: selfTalk.enabled(既定false)やニュース見出しの
// 確率混在(config.ai.selfTalk.newsTopicChance)を待たず、NEWS_POST[_N]を
// 有効にしたアカウントだけ他機能の有効/無効に関係なく単独で動く。
// ニュース見出し(短い事実だけのタイトル)をgenerateSelfTalkのtopicHintとして渡し、
// あくまで話のきっかけとして参考にする一言をLLMに生成させるだけで、記事本文の
// 取得・要約・引用は一切行わない(見出し自体をそのまま投稿することもない)
async function newsPost(client) {
  const state = client.accountState;
  if (state.lockedDown) return;

  const ids = state.channelStore.listChannels();
  if (ids.length === 0) return;

  const headline = await getRandomHeadline();
  if (!headline) return;

  const channelId = ids[Math.floor(Math.random() * ids.length)];
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const text = await generateSelfTalk(state, headline, null);
    if (!text) return;
    await channel.send(text);
    recordReply(state, text);
    logger.log('NEWS', `[${state.id}] ${text}`);
  } catch (err) {
    logger.error('NEWS', err);
  }
}

// NEWS_POST[_N]=trueのアカウントだけ、config.news.postIntervalMsごとに
// ジッター付きで自動投稿する(未設定なら登録自体しない)
function registerNewsPostHandler(client) {
  const state = client.accountState;
  if (!state.newsPostEnabled) return;
  if (!config.news?.postIntervalMs) return;

  const { postIntervalMs, postIntervalJitter = 0.4 } = config.news;
  scheduleWithJitter(postIntervalMs, postIntervalJitter, () => newsPost(client));
}

module.exports = { registerNewsPostHandler };
