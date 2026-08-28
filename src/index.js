require('dotenv').config();

const { createClient } = require('./client');
const { getMultiAccountConfigs, getSingleConfig } = require('./utils/config');
const logger = require('./utils/logger');
const { registerMessageHandler } = require('./handlers/messageHandler');
const { registerSelfTalkHandler } = require('./handlers/selfTalkHandler');
const { registerPresenceHandler } = require('./handlers/presenceHandler');
const { initMarkov } = require('./utils/aiClient');

process.on('unhandledRejection', (err) => logger.error('UNHANDLED', err));
process.on('uncaughtException', (err) => logger.error('UNCAUGHT', err));

/**
 * 単一アカウント用起動処理（従来方式）
 */
async function launchSingleAccount() {
  const config = getSingleConfig();
  const client = createClient(config);

  registerMessageHandler(client, config);
  registerSelfTalkHandler(client, config);

  client.once('ready', () => {
    logger.log('READY', `${client.user.tag} [Single Mode]`);
    registerPresenceHandler(client, config);
  });

  await initMarkov(config);
  await client.login(config.env.discordToken);
}

/**
 * 複数アカウント用起動処理
 */
async function launchMultiAccount() {
  const allConfigs = getMultiAccountConfigs();
  
  logger.log('STARTUP', `複数アカウントモード: ${allConfigs.length}個のアカウントを起動`);

  const clients = [];

  for (const config of allConfigs) {
    try {
      const client = createClient(config);

      registerMessageHandler(client, config);
      registerSelfTalkHandler(client, config);

      client.once('ready', () => {
        logger.log('READY', `${client.user.tag} [Account: ${config.env.accountId}]`);
        registerPresenceHandler(client, config);
      });

      // マルコフ連鎖の初期化（共通なので1回でいい）
      if (clients.length === 0) {
        await initMarkov(config);
      }

      // ログイン（非同期で並行実行）
      client.login(config.env.discordToken).catch((err) => {
        logger.error('LOGIN_FAILED', `Account ${config.env.accountId}: ${err.message}`);
      });

      clients.push(client);

      // アカウント間のリクエスト間隔（レート制限回避）
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      logger.error('ACCOUNT_STARTUP', `Account config error: ${err.message}`);
    }
  }

  logger.log('STARTUP', `すべてのアカウント起動処理を開始しました`);
}

/**
 * メイン処理
 */
async function main() {
  const multiAccountMode = process.env.MULTI_ACCOUNT_MODE === 'true';

  if (multiAccountMode) {
    await launchMultiAccount();
  } else {
    await launchSingleAccount();
  }
}

main().catch((err) => {
  logger.error('FATAL', err);
  process.exit(1);
});
