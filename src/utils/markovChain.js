const fs = require('fs');

class MarkovChain {
  constructor(order = 2) {
    this.order = order;
    this.chain = new Map();
  }

  train(texts) {
    for (const text of texts) {
      const words = text.trim().split(/\s+/).filter(Boolean);
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

    return result.join(' ');
  }

  // 文脈に含まれる単語と重なるキーがあればそこから開始し、
  // なければ従来通りランダムに開始する
  pickStartKey(keys, contextText) {
    const contextWords = new Set(contextText.trim().split(/\s+/).filter(Boolean));
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

module.exports = { MarkovChain, loadCorpus };
