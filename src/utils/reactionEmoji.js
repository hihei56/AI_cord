// メッセージの内容に応じてリアクション絵文字を選ぶ。LLM呼び出しは行わず
// (リアクションのたびにAPIを叩くとGroqの1日トークン枠を無駄に消費するため)、
// キーワードの単純なパターンマッチだけで選ぶ軽量な実装。
// 該当するキーワードが無ければ汎用の絵文字プールからランダムに選ぶ。
const KEYWORD_EMOJI = [
  { re: /(笑|www+|ワロタ|草|わろ)/i, emoji: '😂' },
  { re: /(泣|悲し|辛い|しんど|つら)/i, emoji: '😢' },
  { re: /(すご|やば|マジ|ガチ|えぐ)/i, emoji: '😳' },
  { re: /(かわいい|可愛い|好き|えらい)/i, emoji: '🥰' },
  { re: /(眠|疲れ|だる|ねむ)/i, emoji: '😪' },
  { re: /(おめ|congrat|祝)/i, emoji: '🎉' }
];

const DEFAULT_EMOJI_POOL = ['👍', '🤔', '👀', '✨', '🔥'];

function pickReactionEmoji(content = '') {
  for (const { re, emoji } of KEYWORD_EMOJI) {
    if (re.test(content)) return emoji;
  }
  return DEFAULT_EMOJI_POOL[Math.floor(Math.random() * DEFAULT_EMOJI_POOL.length)];
}

module.exports = { pickReactionEmoji };
