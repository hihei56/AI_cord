const { Client } = require('discord.js-selfbot-v13');
const config = require('./utils/config');
const { buildAccountState } = require('./account');
const { registerClient } = require('./utils/accountRegistry');

function createClients() {
  return config.accounts.map((account) => {
    const client = new Client({
      checkUpdate: false,
      syncStatus: true,
      ws: { properties: { $os: 'Windows', $browser: 'Discord Client', $device: 'Discord Client' } }
    });
    client.accountState = buildAccountState(account);
    registerClient(client);
    return client;
  });
}

module.exports = { createClients };
