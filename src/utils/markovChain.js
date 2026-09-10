const fs = require('fs');
const path = require('path');
const kuromoji = require('kuromoji');

// 文脈マッチング(pickStartKey)で使うと危険な、あまりに一般的・高頻度な単語。
// 「今日」のような語は大半のコーパスに含まれるため、一度誰かが使うと次のAIも
// 同じ単語にマッチしたキーから生成を始め、それがまた次のAIに伝染して
// 「今日は〇〇だし」のような同じパターンの投稿が自己増殖するループになる
// (実際に発生した問題)。こうした語は文脈マッチングの対象から除外する
const CONTEXT_MATCH_STOPWORDS = new Set([
  '今日', '明日', '昨日', '今', 'それ', 'あれ', 'これ', 'ここ', 'そこ',
  'まあ', 'けど', 'でも', 'だから', 'てか', 'そう', 'うん', 'まじ',
  'なんか', 'やっぱ', 'たぶん', 'ちょっと', 'なんとなく'
]);

// 助詞・助動詞などの1文字語(「は」「が」「を」など)はほぼ無意味なので除外したいが、
// 「猫」「雨」のような単漢字の内容語まで一緒に弾いてしまうと文脈マッチングが弱くなりすぎる。
// そのため「1文字かつ漢字ではない」場合のみ短すぎる語として除外する
const KANJI_RE = /^[一-鿿]$/;
function isTooShortForContextMatch(word) {
  return word.length < 2 && !KANJI_RE.test(word);
}

// kuromojiは形態素(表層形)単位でトークン化する。日本語には空白を含まない発言が
// ほとんどのため、これがないと大半のコーパス行が学習に使われず捨てられてしまう。
function buildTokenizer() {
  return new Promise((resolve, reject) => {
    kuromoji
      .builder({ dicPath: path.join(__dirname, '..', '..', 'node_modules', 'kuromoji', 'dict') })
      .build((err, tokenizer) => {
        if (err) reject(err);
        else resolve(tokenizer);
      });
  });
}

class MarkovChain {
  constructor(order = 2, tokenizer = null) {
    this.order = order;
    this.chain = new Map();
    this.tokenizer = tokenizer;
  }

  tokenize(text) {
    const trimmed = text.trim();
    if (!trimmed) return [];
    if (this.tokenizer) {
      return this.tokenizer
        .tokenize(trimmed)
        .map((t) => t.surface_form)
        .filter((w) => w.trim());
    }
    return trimmed.split(/\s+/).filter(Boolean);
  }

  train(texts) {
    for (const text of texts) {
      const words = this.tokenize(text);
      if (words.length <= this.order) continue;

      for (let i = 0; i <= words.length - this.order; i++) {
        const key = words.slice(i, i + this.order).join(' ');
        const next = words[i + this.order];
        if (!next) continue;
        if (!this.chain.has(key)) this.chain.set(key, []);
        this.chain.get(key).push(next);
      }
    }
  }

  generate(maxWords = 20, contextText = '') {
    if (this.chain.size === 0) return null;

    const keys = [...this.chain.keys()];
    let key = this.pickStartKey(keys, contextText);
    const result = key.split(' ');
    // 生成途中で以前通ったキーに戻ってくると、そこから先は決定的な短い周期の
    // ループに入り「AといらないAといらない…」のように同じフレーズを延々と
    // 繰り返してしまう(pickStartKeyの自己増殖ループとは別原因)。
    // 一度通ったキーに戻ったらそこで打ち切る
    const usedKeys = new Set([key]);

    for (let i = 0; i < maxWords; i++) {
      const nexts = this.chain.get(key);
      if (!nexts || nexts.length === 0) break;
      const next = nexts[Math.floor(Math.random() * nexts.length)];
      result.push(next);
      key = result.slice(-this.order).join(' ');
      if (usedKeys.has(key)) break;
      usedKeys.add(key);
    }

    // kuromojiの形態素は日本語として空白なしで繋げてこそ自然な文になる。
    // トークナイザーがない(空白区切りの)フォールバック時のみ空白で繋ぐ。
    return this.tokenizer ? result.join('') : result.join(' ');
  }

  // 文脈に含まれる単語と重なるキーがあればそこから開始し、
  // なければ従来通りランダムに開始する。ただし1文字の語や汎用的すぎる語は
  // 除外する(自己増殖ループの原因になるため。上のCONTEXT_MATCH_STOPWORDS参照)
  pickStartKey(keys, contextText) {
    const contextWords = new Set(
      this.tokenize(contextText).filter((w) => !isTooShortForContextMatch(w) && !CONTEXT_MATCH_STOPWORDS.has(w))
    );
    if (contextWords.size > 0) {
      const matchingKeys = keys.filter((key) => key.split(' ').some((word) => contextWords.has(word)));
      if (matchingKeys.length > 0) return matchingKeys[Math.floor(Math.random() * matchingKeys.length)];
    }
    return keys[Math.floor(Math.random() * keys.length)];
  }
}

function loadCorpus(corpusPath) {
  if (!fs.existsSync(corpusPath)) return [];
  return fs
    .readFileSync(corpusPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

module.exports = { MarkovChain, loadCorpus, buildTokenizer };
