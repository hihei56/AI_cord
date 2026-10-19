const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'x-promo.json');

// X宣伝の投稿履歴(ツイートID・使った招待コード・本文・タグ)を data/x-promo.json に残す。
// 招待コードは投稿ごとに発行しているので、後でDiscord側の招待一覧の使用回数と
// 突き合わせれば「どの投稿(どのタグ・どの文面)から何人入ったか」が分かる。
// また直近の本文をAIに渡して、同じような文面の繰り返しを避けさせるのにも使う
const MAX_HISTORY = 500;

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return { history: [] };
  }
}

const state = load();
state.history = state.history || [];

function save() {
  state.history = state.history.slice(-MAX_HISTORY);
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

function addPost(entry) {
  state.history.push(entry);
  save();
}

function recentTexts(count) {
  return state.history.slice(-count).map((entry) => entry.text);
}

module.exports = { addPost, recentTexts };
