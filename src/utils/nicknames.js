const fs = require('fs');
const path = require('path');
const config = require('./config');

const NICKNAMES_PATH = path.join(__dirname, '..', '..', 'config', 'nicknames.json');

// 優先順位: config/nicknames.json の個別登録 > サーバーのニックネーム(member.displayName) > Discordのusername
function resolveDisplayName(user, member) {
  return config.nicknames?.[user.id] || member?.displayName || user.username;
}

function persistNicknames() {
  fs.writeFileSync(NICKNAMES_PATH, `${JSON.stringify(config.nicknames, null, 2)}\n`, 'utf-8');
}

function setNickname(userId, name) {
  config.nicknames[userId] = name;
  persistNicknames();
}

function removeNickname(userId) {
  delete config.nicknames[userId];
  persistNicknames();
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
