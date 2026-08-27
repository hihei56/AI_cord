const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');

function readText(relativePath) {
  return fs.readFileSync(path.join(CONFIG_DIR, relativePath), 'utf-8').trim();
}

const settings = JSON.parse(readText('settings.json'));

const env = {
  discordToken: process.env.DISCORD_TOKEN,
  groqApiKey: process.env.GROQ_API_KEY,
  allowedGuildId: process.env.ALLOWED_GUILD_ID,
  allowedChannelId: process.env.ALLOWED_CHANNEL_ID,
  personaName: process.env.PERSONA || 'default'
};

const persona = readText(path.join('personas', `${env.personaName}.txt`));
const selfTalkPrompt = readText(path.join('prompts', 'self_talk.txt'));

module.exports = {
  ...settings,
  env,
  persona,
  selfTalkPrompt
};
