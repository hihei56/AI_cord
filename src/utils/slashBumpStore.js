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

// 既にbotId×channelIdの組み合わせが登録済みなら、実行中のタイマーが参照している
// 同じオブジェクトをその場で書き換えて更新する(command/nameの変更を!slashbump add
// のやり直しだけで反映できるようにするため。以前はこの場合を「登録済みエラー」で
// 拒否するだけで、コマンドや表示名を変えたい時に一度removeしてからでないと
// 再設定できず不便だった)。channelIdはキーの一部なので変えられない
// (別チャンネルにしたい場合はremoveしてから新しい組み合わせでaddする)
function addTarget(target) {
  const existing = findTarget(target.botId, target.channelId);
  if (existing) {
    existing.command = target.command;
    existing.name = target.name;
    save();
    return { target: existing, created: false };
  }
  state.targets.push(target);
  save();
  return { target, created: true };
}

function removeTarget(botId, channelId) {
  const idx = state.targets.findIndex((t) => t.botId === botId && t.channelId === channelId);
  if (idx === -1) return null;
  const [removed] = state.targets.splice(idx, 1);
  save();
  return removed;
}

module.exports = { getTargets, findTarget, addTarget, removeTarget };
