const { Client } = require('discord.js-selfbot-v13');
const config = require('./utils/config');
const { buildAccountState } = require('./account');
const { registerClient } = require('./utils/accountRegistry');
const logger = require('./utils/logger');

// 1アカウントの設定ミス(存在しないペルソナ/コーパスファイル名など)で
// buildAccountStateが例外を投げても、他の正常なアカウントまで巻き添えで
// プロセス全体がクラッシュしないよう、アカウント単位でtry/catchして除外する
function createClients() {
  const clients = [];
  for (const account of config.accounts) {
    try {
      const client = new Client({
        checkUpdate: false,
        syncStatus: true,
        ws: { properties: { $os: 'Windows', $browser: 'Discord Client', $device: 'Discord Client' } }
      });
      client.accountState = buildAccountState(account);
      registerClient(client);
      clients.push(client);
    } catch (err) {
      logger.error('CLIENT', `[${account.id}] アカウントの初期化に失敗したためスキップします: ${err.message}`);
    }
  }
  return clients;
}

module.exports = { createClients };
