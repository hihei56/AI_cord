const fs = require('fs');
const path = require('path');

function storePath(accountId) {
  return path.join(__dirname, '..', '..', 'data', `guild-${accountId}.json`);
}

// アカウントごとの動作サーバーID。!guild set で実行中に切り替えられるようにし、
// data/guild-<accountId>.json に永続化する(.envを書き換えずにサーバーを移動するため)。
// ファイルが無ければ .env の ALLOWED_GUILD_ID[_N](無ければ既定値)を使う
function loadGuildId(accountId, fallbackGuildId) {
  try {
    const saved = JSON.parse(fs.readFileSync(storePath(accountId), 'utf-8'));
    return saved.guildId || fallbackGuildId;
  } catch {
    return fallbackGuildId;
  }
}

function saveGuildId(accountId, guildId) {
  const filePath = storePath(accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ guildId }, null, 2));
}

module.exports = { loadGuildId, saveGuildId };
