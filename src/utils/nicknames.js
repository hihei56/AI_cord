const fs = require('fs');
const path = require('path');
const config = require('./config');

const { readJson } = require('./jsonFile');

// 呼び名の登録は2段構え: config/nicknames.json(git管理の初期値)と、!nickname set/remove で
// 実行中に変えた分を保存する data/nicknames.json(上書き。nullは「初期値の登録を消した」)。
// 以前は config/nicknames.json に直接書き込んでいたが、デプロイは git reset --hard で
// 作業ツリーを丸ごとリポジトリの状態に戻すため、実行中に登録した呼び名がデプロイのたびに消えていた
const OVERRIDES_PATH = path.join(__dirname, '..', '..', 'data', 'nicknames.json');
const overrides = readJson(OVERRIDES_PATH, {});
for (const [id, name] of Object.entries(overrides)) {
  if (name === null) delete config.nicknames[id];
  else config.nicknames[id] = name;
}

// 優先順位: config/nicknames.json の個別登録 > サーバーのニックネーム(member.displayName) > Discordのusername
function resolveDisplayName(user, member) {
  return config.nicknames?.[user.id] || member?.displayName || user.username;
}

function persistOverrides() {
  fs.mkdirSync(path.dirname(OVERRIDES_PATH), { recursive: true });
  fs.writeFileSync(OVERRIDES_PATH, `${JSON.stringify(overrides, null, 2)}\n`, 'utf-8');
}

function setNickname(userId, name) {
  config.nicknames[userId] = name;
  overrides[userId] = name;
  persistOverrides();
}

function removeNickname(userId) {
  delete config.nicknames[userId];
  overrides[userId] = null;
  persistOverrides();
}

const MIN_NAME_LENGTH = 2;

// 本文中で名前を呼ばれているか。英数字だけの名前(例: "mi" "sui")は単純な部分一致だと
// "mini" "suica" のような無関係な単語の一部にも一致してしまうため、前後が英数字でない
// 場合だけ一致とする。日本語の名前は単語の区切りが無いので部分一致で判定する
function textMentionsName(text, name) {
  if (!text || !name || name.length < MIN_NAME_LENGTH) return false;
  const t = text.toLowerCase();
  const n = name.toLowerCase();
  if (!/^[\x20-\x7e]+$/.test(n)) return t.includes(n);
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(t);
}

module.exports = { resolveDisplayName, setNickname, removeNickname, textMentionsName };
