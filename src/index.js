require('dotenv').config();

const { createClient } = require('./client');
const config = require('./utils/config');
const logger = require('./utils/logger');
const { registerMessageHandler } = require('./handlers/messageHandler');
const { registerSelfTalkHandler } = require('./handlers/selfTalkHandler');
const { registerPresenceHandler } = require('./handlers/presenceHandler');

const client = createClient();

registerMessageHandler(client);
registerSelfTalkHandler(client);

client.once('ready', () => {
  logger.log('READY', client.user.tag);
  registerPresenceHandler(client);
});

client.login(config.env.discordToken);
