const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

// れおうーんbot方式の知識ベース: config/knowledge/ に置いた .md / .txt(サーバーの歴史・
// 内輪ネタ・用語集など)を見出しや空行で小さな塊に分け、会話に関係ありそうな塊だけを
// プロンプトに差し込む。「第九世代の安全雑談って?」のような内輪の質問に、
// 書いておいた知識に沿って答えられるようにする。
//
// 検索は埋め込みモデルを使わず、文字2-gramの一致をIDF(多くの塊に出てくる2-gramほど
// 軽く数える)で重み付けしたスコアで行う。LLMやAPIを一切呼ばないので無料・即時。
// ファイルは1分に1回だけ更新を確認し、書き換えれば再起動なしで反映される
const DIR = path.join(__dirname, '..', '..', 'config', 'knowledge');
// minMatchedGrams: 一致した2-gramがこれ未満なら関係なしとする(「一番」1語だけの偶然の一致を拾わない)
const K = { maxChunks: 2, minScore: 0.3, minMatchedGrams: 3, chunkMaxChars: 500, ...(config.knowledge || {}) };

let chunks = [];
let idf = new Map();
let signature = '';
let lastCheckedAt = 0;

// 「第9世代」と「第九世代」、全角数字と半角数字を同じものとして扱う(十・百などの位取りは扱わない)
const KANJI_DIGITS = { 〇: '0', 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };

function normalize(s) {
  return s
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[〇一二三四五六七八九](?=[世代期回目部号章])|(?<=第)[〇一二三四五六七八九]/g, (d) => KANJI_DIGITS[d])
    .toLowerCase()
    .replace(/[\s、。,.!?！？「」『』()（）【】・…ー〜~#*\-_:：]/g, '');
}

function grams(s) {
  const t = normalize(s);
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function splitIntoChunks(text, source) {
  // 見出し(#)の直前か空行で区切る。長すぎる塊は文字数で分ける
  const parts = text.split(/\n(?=#)|\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    for (let i = 0; i < part.length; i += K.chunkMaxChars) {
      const body = part.slice(i, i + K.chunkMaxChars);
      out.push({ source, text: body, grams: grams(body) });
    }
  }
  return out;
}

function reloadIfChanged() {
  if (Date.now() - lastCheckedAt < 60000) return;
  lastCheckedAt = Date.now();
  let files;
  try {
    files = fs.readdirSync(DIR).filter((f) => /\.(md|txt)$/i.test(f));
  } catch {
    chunks = [];
    return;
  }
  const sig = files.map((f) => `${f}:${fs.statSync(path.join(DIR, f)).mtimeMs}`).join('|');
  if (sig === signature) return;
  signature = sig;

  chunks = files.flatMap((f) => splitIntoChunks(fs.readFileSync(path.join(DIR, f), 'utf-8'), f));
  const df = new Map();
  for (const c of chunks) for (const g of c.grams) df.set(g, (df.get(g) || 0) + 1);
  idf = new Map([...df].map(([g, n]) => [g, Math.log(1 + chunks.length / n)]));
  logger.log('KNOWLEDGE', `知識ベースを読み込み: ${files.length}ファイル / ${chunks.length}塊`);
}

// queryに関係する塊のテキストを最大maxChunks件返す(無ければ空配列)
function lookup(query) {
  reloadIfChanged();
  if (!query || chunks.length === 0) return [];
  // 知識ベースに一度も出てこない2-gram(「教えて」等)は分母から外す
  const q = [...grams(query)].filter((g) => idf.has(g));
  const total = q.reduce((a, g) => a + idf.get(g), 0);
  if (total === 0) return [];

  return chunks
    .map((c) => {
      const hit = q.filter((g) => c.grams.has(g));
      return { c, hits: hit.length, score: hit.reduce((a, g) => a + idf.get(g), 0) / total };
    })
    .filter((x) => x.hits >= K.minMatchedGrams && x.score >= K.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, K.maxChunks)
    .map((x) => x.c.text);
}

module.exports = { lookup };
