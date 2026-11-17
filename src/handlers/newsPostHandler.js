const config = require('../utils/config');
const logger = require('../utils/logger');
const { generateSelfTalk, recordReply } = require('../utils/aiClient');
const { getRandomHeadline } = require('../utils/newsTopics');
const humanTiming = require('../utils/humanTiming');

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

  const channelId = ids[Math.floor(Math.random() * ids.length)];
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  // 人がいない時間帯は控え、誰も反応していない所には重ねて書かない(humanTiming参照)
  if (!humanTiming.activeNow(channel.guild?.id) || humanTiming.waitingForReply(channel)) return;

  const headline = await getRandomHeadline();
  if (!headline) return;

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

// NEWS_POST[_N]=trueのアカウントだけ、平均でconfig.news.postIntervalMsに1回(人が一番多い時間帯の頻度)
// 自動投稿する。間隔は指数分布でばらつき、時間帯と反応の有無で間引く(未設定なら登録自体しない)
function registerNewsPostHandler(client) {
  const state = client.accountState;
  if (!state.newsPostEnabled) return;
  if (!config.news?.postIntervalMs) return;

  humanTiming.scheduleHumanLike(config.news.postIntervalMs, () => newsPost(client));
}

module.exports = { registerNewsPostHandler };
