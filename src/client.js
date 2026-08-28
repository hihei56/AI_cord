const { Client } = require('discord.js-selfbot-v13');

/**
 * Discord クライアントを生成
 * @param {Object} config - 設定オブジェクト（オプション、複数アカウント対応）
 * @returns {Client} discord.js-selfbot-v13 クライアント
 */
function createClient(config) {
  return new Client({
    checkUpdate: false,
    syncStatus: true,
    ws: {
      properties: {
        $os: 'Windows',
        $browser: 'Discord Client',
        $device: 'Discord Client'
      }
    }
  });
}

module.exports = { createClient };
