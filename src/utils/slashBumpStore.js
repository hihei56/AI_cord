const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'slash-bump.json');

// 対象BOT・実行するスラッシュコマンド・チャンネルの組み合わせ(targets)を
// data/slash-bump.json に永続化する(.envを書き換えずコマンドだけで設定できるように)。
// 実行間隔やクールダウン状態はプロセスの実行時状態(slashBumpHandler.js側)で管理し、
// ここでは「何を対象にするか」の設定だけを持つ。
function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return { targets: [] };
  }
}

const state = load();
state.targets = state.targets || [];

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

function getTargets() {
  return state.targets;
}

function findTarget(botId, channelId) {
  return state.targets.find((t) => t.botId === botId && t.channelId === channelId);
}

function addTarget(target) {
  if (findTarget(target.botId, target.channelId)) return null;
  state.targets.push(target);
  save();
  return target;
}

function removeTarget(botId, channelId) {
  const idx = state.targets.findIndex((t) => t.botId === botId && t.channelId === channelId);
  if (idx === -1) return null;
  const [removed] = state.targets.splice(idx, 1);
  save();
  return removed;
}

module.exports = { getTargets, findTarget, addTarget, removeTarget };
