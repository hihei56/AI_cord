const config = require('./config');

// config/nicknames.json に登録があればそれを使い、無ければ通常のDiscord usernameのまま
function resolveDisplayName(user) {
  return config.nicknames?.[user.id] || user.username;
}

module.exports = { resolveDisplayName };
