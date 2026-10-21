const fs = require('fs');
const path = require('path');

// チャンネル転送(relay)の設定(監視元・転送先・有効/無効)をアカウントごとに
// data/relay-<accountId>.jsonへ永続化する。.envのRELAY_*は初回起動時の初期値としてのみ
// 使い、以降は!relayコマンドで再起動不要に変更できるようにするため
function storePath(accountId) {
  return path.join(__dirname, '..', '..', 'data', `relay-${accountId}.json`);
}

function load(accountId) {
  try {
    return JSON.parse(fs.readFileSync(storePath(accountId), 'utf-8'));
  } catch {
    return null;
  }
}

function save(accountId, state) {
  const filePath = storePath(accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function loadOrInit(accountId, defaults) {
  const existing = load(accountId);
  if (existing) return existing;
  save(accountId, defaults);
  return { ...defaults };
}

// state(accountState.relayと同じ参照)をその場で書き換えて保存する。こうすることで
// 既にstateを読んでいるrelayHandler.js側は何も変更せず変更をすぐ反映できる
function setSource(accountId, state, guildId, channelId) {
  state.sourceGuildId = guildId;
  state.sourceChannelId = channelId;
  save(accountId, state);
  return state;
}

function addDestination(accountId, state, channelId) {
  if (state.destinationChannelIds.includes(channelId)) return false;
  state.destinationChannelIds.push(channelId);
  save(accountId, state);
  return true;
}

function removeDestination(accountId, state, channelId) {
  const idx = state.destinationChannelIds.indexOf(channelId);
  if (idx === -1) return false;
  state.destinationChannelIds.splice(idx, 1);
  save(accountId, state);
  return true;
}

function setEnabled(accountId, state, enabled) {
  state.enabled = enabled;
  save(accountId, state);
  return state;
}

module.exports = { loadOrInit, setSource, addDestination, removeDestination, setEnabled };
