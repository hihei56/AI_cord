require('dotenv').config();

const { createClients } = require('./client');
const logger = require('./utils/logger');
const { registerMessageHandler } = require('./handlers/messageHandler');
const { registerSelfTalkHandler } = require('./handlers/selfTalkHandler');
const { registerPresenceHandler } = require('./handlers/presenceHandler');
const { registerCommandHandler } = require('./commands/handler');
const { registerReminderScheduler } = require('./reminderScheduler');
const { registerConversationSeedHandler } = require('./handlers/conversationSeedHandler');
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
    client.once('ready', () => {
      logger.log('READY', `[${client.accountState.id}] ${client.user.tag}`);
      registerOwnAccount(client.user.id);
      registerPresenceHandler(client);
      registerReminderScheduler(client);
    });
  }

  registerConversationSeedHandler(clients);

  const results = await Promise.allSettled(
    clients.map((client) => client.login(client.accountState.discordToken))
  );

  const failures = results.filter((r) => r.status === 'rejected');
  failures.forEach((f) => logger.error('LOGIN', f.reason));

  if (failures.length === clients.length) {
    logger.error('FATAL', '全アカウントのログインに失敗しました');
    process.exit(1);
  }
}

start();
