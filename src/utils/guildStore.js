const fs = require('fs');
const path = require('path');

function storePath(accountId) {
  return path.join(__dirname, '..', '..', 'data', `guilds-${accountId}.json`);
}

// アカウントごとに動作してよいサーバー一覧を持つ(複数サーバー掛け持ち用)。
// !guild add/remove で実行中に変更でき、data/guilds-<accountId>.json に永続化する。
// ファイルが無い初回だけ .env の ALLOWED_GUILD_ID[_N] と既定値(config.js)を初期値にする
function createGuildStore(accountId, seedGuildIds) {
  const filePath = storePath(accountId);

  function load() {
    try {
      return new Set(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    } catch {
      return new Set(seedGuildIds.filter(Boolean));
    }
  }

  const guilds = load();

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([...guilds], null, 2));
  }

  return {
    isAllowedGuild: (guildId) => Boolean(guildId) && guilds.has(guildId),
    addGuild: (guildId) => {
      const added = !guilds.has(guildId);
      guilds.add(guildId);
      if (added) save();
      return added;
    },
    removeGuild: (guildId) => {
      const removed = guilds.delete(guildId);
      if (removed) save();
      return removed;
    },
    listGuilds: () => [...guilds]
  };
}

module.exports = { createGuildStore };
