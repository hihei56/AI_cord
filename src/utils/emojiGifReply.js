const config = require('./config');
const { pickReactionEmoji } = require('./reactionEmoji');
const { fetchRandomGif } = require('./klipyGif');

// 「絵文字と指定キーワードのGIFのみでやり取りする」モード。有効な場合、
// messageHandler/selfTalkHandler/conversationSeedHandlerのどのLLM呼び出し箇所も
// 一切使わず、代わりにこのモジュールの内容を送る(自我=ペルソナ・マルコフ下書きに
// よる文章生成を完全に止める)
function isEmojiGifOnlyMode() {
  return Boolean(config.emojiGifOnlyMode?.enabled);
}

// LLMは一切呼ばない。アカウントにgifGenres(!gifgenreで管理)が設定されていれば
// gifChanceの確率でKlipy検索したGIFを、それ以外(未設定/確率で外れた/取得失敗)は
// キーワードパターンマッチの絵文字(reactionEmoji.js、該当無しならランダムプール)を返す。
// nullは返さない(常に何かしら送る内容がある)
async function pickEmojiOrGif(accountState, contextText) {
  const { gifChance = 0.5 } = config.emojiGifOnlyMode || {};
  if (accountState?.gifGenres?.length && Math.random() < gifChance) {
    const genre = accountState.gifGenres[Math.floor(Math.random() * accountState.gifGenres.length)];
    const url = await fetchRandomGif(genre);
    if (url) return url;
  }
  return pickReactionEmoji(contextText || '');
}

module.exports = { isEmojiGifOnlyMode, pickEmojiOrGif };
