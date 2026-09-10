require('dotenv').config();

const config = require('./utils/config');
const { createClients } = require('./client');
const logger = require('./utils/logger');
const { registerMessageHandler } = require('./handlers/messageHandler');
const { registerSelfTalkHandler } = require('./handlers/selfTalkHandler');
const { registerPresenceHandler } = require('./handlers/presenceHandler');
const { registerPresenceTrackerHandler } = require('./handlers/presenceTrackerHandler');
const { registerCommandHandler } = require('./commands/handler');
const { registerReminderScheduler } = require('./reminderScheduler');
const { registerConversationSeedHandler } = require('./handlers/conversationSeedHandler');
const { registerPriceAlertHandler } = require('./handlers/priceAlertHandler');
const { registerSlashBumpHandler } = require('./handlers/slashBumpHandler');
const { registerMealImageHandler } = require('./handlers/mealImageHandler');
const { registerOwnAccount } = require('./utils/ownAccounts');
const { initMarkov } = require('./utils/aiClient');

process.on('unhandledRejection', (err) => logger.error('UNHANDLED', err));
process.on('uncaughtException', (err) => logger.error('UNCAUGHT', err));

const clients = createClients();

if (clients.length === 0) {
  logger.error('FATAL', 'DISCORD_TOKENが1つも設定されていません(.envを確認してください)');
  process.exit(1);
}

async function start() {
  await Promise.all(clients.map((client) => initMarkov(client.accountState)));

  for (const client of clients) {
    registerMessageHandler(client);
    registerSelfTalkHandler(client);
    registerCommandHandler(client);
    registerPresenceTrackerHandler(client);
    client.once('ready', () => {
      logger.log('READY', `[${client.accountState.id}] ${client.user.tag}`);
      registerOwnAccount(client.user.id);
      registerPresenceHandler(client);
      registerReminderScheduler(client);
    });
  }

  registerConversationSeedHandler(clients);
  registerPriceAlertHandler(clients);
  registerSlashBumpHandler(clients);
  registerMealImageHandler(clients);

  const results = await loginStaggered(clients);

  const failures = results.filter((r) => r.status === 'rejected');
  failures.forEach((f) => logger.error('LOGIN', f.reason));

  if (failures.length === clients.length) {
    logger.error('FATAL', '全アカウントのログインに失敗しました');
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 全アカウントがPromise.allSettledで同時にlogin()すると、pm2再起動のたびに
// 「別々のはずの複数アカウントが寸分違わず同時にオフライン→オンラインを繰り返す」
// という、自動化を疑わせる分かりやすいパターンになってしまう。1アカウントずつ
// ランダムな間隔を空けて順にログインすることで、人間が別々のタイミングで
// クライアントを開くのに近い挙動にする。他のアカウントのログイン失敗で
// 巻き添えにならないよう、失敗しても続行してPromise.allSettledと同じ形の
// 結果配列を返す
async function loginStaggered(clients) {
  const { minMs = 8000, maxMs = 30000 } = config.loginStagger || {};
  const results = [];

  for (let i = 0; i < clients.length; i++) {
    if (i > 0) {
      await sleep(minMs + Math.random() * (maxMs - minMs));
    }
    try {
      await clients[i].login(clients[i].accountState.discordToken);
      results.push({ status: 'fulfilled' });
    } catch (err) {
      results.push({ status: 'rejected', reason: err });
    }
  }

  return results;
}

start();
