const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');

function readText(relativePath) {
  return fs.readFileSync(path.join(CONFIG_DIR, relativePath), 'utf-8').trim();
}

const settings = JSON.parse(readText('settings.json'));
const selfTalkPrompt = readText(path.join('prompts', 'self_talk.txt'));

function readPersona(personaName) {
  return readText(path.join('personas', `${personaName}.txt`));
}

function corpusPathFor(corpusFile) {
  return path.join(CONFIG_DIR, 'corpus', corpusFile || settings.markov?.corpusFile || 'default.txt');
}

// アカウントは .env の DISCORD_TOKEN(無印、後方互換用) と
// DISCORD_TOKEN_2, DISCORD_TOKEN_3... (2つ目以降)から読み込む。
// 無印だけならこれまで通り単一アカウントとして動く。
function loadAccounts() {
  const accounts = [];

  if (process.env.DISCORD_TOKEN) {
    accounts.push({
      id: '1',
      discordToken: process.env.DISCORD_TOKEN,
      allowedGuildId: process.env.ALLOWED_GUILD_ID,
      allowedChannelId: process.env.ALLOWED_CHANNEL_ID,
      personaName: process.env.PERSONA || 'default',
      corpusFile: process.env.CORPUS_FILE
    });
  }

  let i = accounts.length > 0 ? 2 : 1;
  while (process.env[`DISCORD_TOKEN_${i}`]) {
    accounts.push({
      id: String(i),
      discordToken: process.env[`DISCORD_TOKEN_${i}`],
      allowedGuildId: process.env[`ALLOWED_GUILD_ID_${i}`],
      allowedChannelId: process.env[`ALLOWED_CHANNEL_ID_${i}`],
      personaName: process.env[`PERSONA_${i}`] || 'default',
      corpusFile: process.env[`CORPUS_FILE_${i}`]
    });
    i++;
  }

  return accounts;
}

const env = {
  aiBaseUrl: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
  aiApiKey: process.env.AI_API_KEY || process.env.GROQ_API_KEY
};

module.exports = {
  ...settings,
  env,
  selfTalkPrompt,
  readPersona,
  corpusPathFor,
  accounts: loadAccounts()
};
