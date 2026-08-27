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

  generate(maxWords = 20) {
    if (this.chain.size === 0) return null;

    const keys = [...this.chain.keys()];
    let key = keys[Math.floor(Math.random() * keys.length)];
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
