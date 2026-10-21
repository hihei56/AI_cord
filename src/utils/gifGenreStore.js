const fs = require('fs');
const path = require('path');

// GIF_GENRE[_N]で.envに書いたキーワードは初回起動時の初期値としてのみ使い、
// 以降は!gifgenreコマンドで追加/削除した内容をdata/gif-genres-<accountId>.jsonに
// 永続化する(.envを書き換えず再起動不要でキーワードを増減できるようにするため)
function storePath(accountId) {
  return path.join(__dirname, '..', '..', 'data', `gif-genres-${accountId}.json`);
}

function load(accountId) {
  try {
    return JSON.parse(fs.readFileSync(storePath(accountId), 'utf-8'));
  } catch {
    return null;
  }
}

function save(accountId, genres) {
  const filePath = storePath(accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ genres }, null, 2));
}

// 永続化済みの内容があればそれを、無ければenvGenresを初期値として保存してから返す
function loadOrInit(accountId, envGenres) {
  const existing = load(accountId);
  if (existing) return existing.genres || [];
  save(accountId, envGenres);
  return [...envGenres];
}

// genres配列はaccountState.gifGenresと同じ参照を渡してもらい、その場でpush/spliceする。
// こうすることで、既にこの配列を読んでいる側(klipyGif.js等)は何も変更せずに
// 追加/削除をすぐ反映できる
function addGenre(accountId, genres, keyword) {
  if (genres.includes(keyword)) return false;
  genres.push(keyword);
  save(accountId, genres);
  return true;
}

function removeGenre(accountId, genres, keyword) {
  const idx = genres.indexOf(keyword);
  if (idx === -1) return false;
  genres.splice(idx, 1);
  save(accountId, genres);
  return true;
}

module.exports = { loadOrInit, addGenre, removeGenre };
