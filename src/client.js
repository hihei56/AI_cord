const { Client } = require('discord.js-selfbot-v13');

function createClient() {
  return new Client({
    checkUpdate: false,
    syncStatus: true,
    ws: { properties: { $os: 'Windows', $browser: 'Discord Client', $device: 'Discord Client' } }
  });
}

module.exports = { createClient };
