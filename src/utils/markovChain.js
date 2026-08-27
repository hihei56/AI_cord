const fs = require('fs');
const path = require('path');
const kuromoji = require('kuromoji');

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

    for (let i = 0; i < maxWords; i++) {
      const nexts = this.chain.get(key);
      if (!nexts || nexts.length === 0) break;
      const next = nexts[Math.floor(Math.random() * nexts.length)];
      result.push(next);
      key = result.slice(-this.order).join(' ');
    }

    // kuromojiの形態素は日本語として空白なしで繋げてこそ自然な文になる。
    // トークナイザーがない(空白区切りの)フォールバック時のみ空白で繋ぐ。
    return this.tokenizer ? result.join('') : result.join(' ');
  }

  // 文脈に含まれる単語と重なるキーがあればそこから開始し、
  // なければ従来通りランダムに開始する
  pickStartKey(keys, contextText) {
    const contextWords = new Set(this.tokenize(contextText));
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
