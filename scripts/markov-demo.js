/**
 * マルコフ連鎖の学習・生成を単体で試すためのスクリプト。
 * Botを起動せずに config/corpus/ のテキストだけで挙動を確認できる。
 *
 * 使い方:
 *   node scripts/markov-demo.js [corpusFile] [order] [count] [contextText]
 *
 * 例:
 *   node scripts/markov-demo.js default.txt 2 5
 *   → config/corpus/default.txt を order=2 で学習し、5個生成して表示
 *   node scripts/markov-demo.js default.txt 2 5 "山川"
 *   → 生成時に文脈として「山川」を渡し、一致するキーがあれば優先して開始する
 */

const path = require('path');
const { MarkovChain, loadCorpus, buildTokenizer } = require('../src/utils/markovChain');

const corpusFile = process.argv[2] || 'default.txt';
const order = parseInt(process.argv[3], 10) || 2;
const count = parseInt(process.argv[4], 10) || 5;
const contextText = process.argv[5] || '';

const corpusPath = path.join(__dirname, '..', 'config', 'corpus', corpusFile);

async function main() {
  const lines = loadCorpus(corpusPath);

  if (lines.length === 0) {
    console.log(`[markov-demo] ${corpusPath} が空か存在しません。`);
    console.log('config/corpus/ にテキストファイルを置いて、1行1発言の形式で書いてください。');
    process.exit(1);
  }

  console.log(`[markov-demo] corpus: ${corpusPath}`);
  console.log(`[markov-demo] 学習データ行数: ${lines.length}`);
  console.log(`[markov-demo] order (n-gram長): ${order}`);
  if (contextText) console.log(`[markov-demo] context: ${contextText}`);
  console.log('[markov-demo] kuromoji辞書を読み込み中...');
  console.log('');

  const tokenizer = await buildTokenizer();
  const chain = new MarkovChain(order, tokenizer);
  chain.train(lines);

  console.log(`[markov-demo] 学習済みキー数: ${chain.chain.size}`);
  console.log('');
  console.log(`--- 生成サンプル(${count}個) ---`);

  for (let i = 0; i < count; i++) {
    const result = chain.generate(20, contextText);
    console.log(`${i + 1}: ${result ?? '(生成失敗。学習データが少なすぎる可能性)'}`);
  }
}

main();
