const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'house-watch.json');
// 通知済みスレキーの保持上限。実況Gのスレは数時間で落ちるので、古い順に捨てても再通知は起きない
const MAX_SEEN = 1000;

// 通知先チャンネルと通知済み(または判定済みで対象外だった)スレキーを
// data/house-watch.json に永続化する。再起動で同じスレを二重通知しないため
function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return { channelId: null, seen: [] };
  }
}

const state = load();
state.seen = state.seen || [];
const seenSet = new Set(state.seen);

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

function getChannelId() {
  return state.channelId;
}

function setChannelId(channelId) {
  state.channelId = channelId;
  save();
}

function hasSeen(key) {
  return seenSet.has(key);
}

function markSeen(keys) {
  const fresh = keys.filter((k) => !seenSet.has(k));
  if (fresh.length === 0) return;
  for (const k of fresh) seenSet.add(k);
  state.seen.push(...fresh);
  while (state.seen.length > MAX_SEEN) seenSet.delete(state.seen.shift());
  save();
}

module.exports = { getChannelId, setChannelId, hasSeen, markSeen };
