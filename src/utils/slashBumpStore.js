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
// サーバーID → そのサーバーでスラッシュコマンドを実行するmealpostアカウント番号
state.guildAccounts = state.guildAccounts || {};

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
  // mode未指定なら従来通りの「クールダウンを見ながら繰り返し実行」(continuous)を既定にする。
  // 1日1回ランダムな時刻に実行したいだけの対象は!slashbump modeで後からdailyに切り替える
  const newTarget = { mode: 'continuous', ...target };
  state.targets.push(newTarget);
  save();
  return { target: newTarget, created: true };
}

function removeTarget(botId, channelId) {
  const idx = state.targets.findIndex((t) => t.botId === botId && t.channelId === channelId);
  if (idx === -1) return null;
  const [removed] = state.targets.splice(idx, 1);
  save();
  return removed;
}

// !slashbump assign で、サーバーごとにどのmealpostアカウントが実行するかを割り当てる
// アカウントは番号(1, 2...)でも内部ID(mealpost, mealpost2...)でも指定できるよう、
// 内部IDに揃えて保存・比較する
function normalizeAccountId(accountId) {
  const id = String(accountId);
  if (id === '1') return 'mealpost';
  if (/^\d+$/.test(id)) return `mealpost${id}`;
  return id;
}

function getGuildAccount(guildId) {
  const accountId = state.guildAccounts[guildId];
  return accountId ? normalizeAccountId(accountId) : null;
}

function setGuildAccount(guildId, accountId) {
  state.guildAccounts[guildId] = normalizeAccountId(accountId);
  save();
}

function removeGuildAccount(guildId) {
  if (!state.guildAccounts[guildId]) return false;
  delete state.guildAccounts[guildId];
  save();
  return true;
}

function getGuildAccounts() {
  return { ...state.guildAccounts };
}


// 対象BOTのbump実行のたびに、指定した人間のユーザーをメンションして
// 「bump確認してください」ベースのランダムな一言で喚起する機能用の設定。
// userIdがfalsyならメンション通知をオフにする(キー自体を削除する)
function setMentionUser(botId, channelId, userId) {
  const target = findTarget(botId, channelId);
  if (!target) return null;
  if (userId) target.mentionUserId = userId;
  else delete target.mentionUserId;
  save();
  return target;
}

// mode: 'continuous'(既定、クールダウンを見ながら繰り返し実行) / 'daily'(1日1回、
// 日中活動時間帯からランダムな時刻に1回だけ実行)。切り替えは!slashbump modeコマンドから
function setMode(botId, channelId, mode) {
  const target = findTarget(botId, channelId);
  if (!target) return null;
  target.mode = mode;
  save();
  return target;
}

module.exports = {
  getTargets,
  findTarget,
  addTarget,
  removeTarget,
  setMentionUser,
  setMode,
  getGuildAccount,
  setGuildAccount,
  removeGuildAccount,
  getGuildAccounts,
  normalizeAccountId
};
