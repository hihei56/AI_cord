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

module.exports = { resolveDisplayName, setNickname, removeNickname };
