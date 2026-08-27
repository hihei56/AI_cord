require('dotenv').config();

const { createClient } = require('./client');
const config = require('./utils/config');
const logger = require('./utils/logger');
const { registerMessageHandler } = require('./handlers/messageHandler');
const { registerSelfTalkHandler } = require('./handlers/selfTalkHandler');
const { registerPresenceHandler } = require('./handlers/presenceHandler');
const { initMarkov } = require('./utils/aiClient');

const client = createClient();

registerMessageHandler(client);
registerSelfTalkHandler(client);

client.once('ready', () => {
  logger.log('READY', client.user.tag);
  registerPresenceHandler(client);
});

initMarkov().finally(() => client.login(config.env.discordToken));
