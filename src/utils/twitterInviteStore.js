const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'twitter-invites.json');

// 一度共有した(または無効と判明した)招待コードと、共有済みサーバーのIDを
// data/twitter-invites.json に永続化する。同じツイートは検索のたびに何度も
// 引っかかるし、同じサーバーが別の招待コードで宣伝されることも多いので、
// 招待コードとサーバーIDの両方で重複を弾く。再起動を挟んでも二重投稿しないよう
// ファイルに残している。無制限に増えないよう古いものから捨てる
const MAX_ENTRIES = 5000;

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return { seenCodes: [], seenGuildIds: [] };
  }
}

const state = load();
state.seenCodes = state.seenCodes || [];
state.seenGuildIds = state.seenGuildIds || [];

const seenCodes = new Set(state.seenCodes);
const seenGuildIds = new Set(state.seenGuildIds);

function save() {
  state.seenCodes = [...seenCodes].slice(-MAX_ENTRIES);
  state.seenGuildIds = [...seenGuildIds].slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

// 招待コードは大文字小文字を区別するのでそのまま扱う
function hasCode(code) {
  return seenCodes.has(code);
}

function hasGuild(guildId) {
  return seenGuildIds.has(guildId);
}

function markCode(code) {
  seenCodes.delete(code);
  seenCodes.add(code);
  save();
}

function markGuild(guildId) {
  seenGuildIds.delete(guildId);
  seenGuildIds.add(guildId);
  save();
}

module.exports = { hasCode, hasGuild, markCode, markGuild };
