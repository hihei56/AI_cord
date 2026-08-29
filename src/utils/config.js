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

function presenceFor(presenceFile) {
  return JSON.parse(readText(path.join('presence', presenceFile || settings.presenceFile || 'default.json')));
}

function numEnv(name) {
  return process.env[name] !== undefined ? Number(process.env[name]) : undefined;
}

// !pause/!set channel等をロール経由で実行できる既定のロールID。サーバーによって
// 持ってるロールが違うので複数許可する。ロールIDは秘密情報ではないのでハードコードしてよく、
// .envで ALLOWED_COMMAND_ROLE_ID[_N] にカンマ区切りで指定すれば上書きできる
const DEFAULT_COMMAND_ROLE_IDS = ['1495971497016164492', '1543226849788825620'];

function resolveCommandRoleIds(envVal) {
  if (!envVal) return DEFAULT_COMMAND_ROLE_IDS;
  return envVal.split(',').map((id) => id.trim()).filter(Boolean);
}

// 起動時点のAIモード。!set mode で切り替えても再起動でmarkovに戻ってしまうので、
// finetuneモードを常用したいアカウントは AI_MODE[_N]=finetune を設定しておく
function resolveAiMode(envVal) {
  return envVal === 'finetune' ? 'finetune' : 'markov';
}

// アカウントごとにコマンドprefixを分ける(同じ!だとどのアカウント宛てか紛らわしいため)。
// .envで COMMAND_PREFIX[_N] を設定すれば上書きできる
const DEFAULT_COMMAND_PREFIXES = { 1: 'toku!', 2: 'sui!' };

// 特別な呼び方をしたい相手だけ config/nicknames.json に { "ユーザーID": "呼び名" }
// で個別登録する。登録が無いユーザーは今まで通りDiscordのusernameで呼ぶ
function loadNicknames() {
  try {
    return JSON.parse(readText('nicknames.json'));
  } catch {
    return {};
  }
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
      corpusFile: process.env.CORPUS_FILE,
      presenceFile: process.env.PRESENCE_FILE,
      cooldownSecondsOverride: numEnv('COOLDOWN_SECONDS'),
      replyChanceMultiplierOverride: numEnv('REPLY_CHANCE_MULTIPLIER'),
      commandRoleIds: resolveCommandRoleIds(process.env.ALLOWED_COMMAND_ROLE_ID),
      commandPrefix: process.env.COMMAND_PREFIX || DEFAULT_COMMAND_PREFIXES[1] || settings.commandPrefix || '!',
      finetuneBaseUrl: process.env.FINETUNE_BASE_URL,
      finetuneApiKey: process.env.FINETUNE_API_KEY,
      finetuneModel: process.env.FINETUNE_MODEL,
      aiMode: resolveAiMode(process.env.AI_MODE)
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
      corpusFile: process.env[`CORPUS_FILE_${i}`],
      presenceFile: process.env[`PRESENCE_FILE_${i}`],
      cooldownSecondsOverride: numEnv(`COOLDOWN_SECONDS_${i}`),
      replyChanceMultiplierOverride: numEnv(`REPLY_CHANCE_MULTIPLIER_${i}`),
      commandRoleIds: resolveCommandRoleIds(process.env[`ALLOWED_COMMAND_ROLE_ID_${i}`]),
      commandPrefix: process.env[`COMMAND_PREFIX_${i}`] || DEFAULT_COMMAND_PREFIXES[i] || settings.commandPrefix || '!',
      finetuneBaseUrl: process.env[`FINETUNE_BASE_URL_${i}`],
      finetuneApiKey: process.env[`FINETUNE_API_KEY_${i}`],
      finetuneModel: process.env[`FINETUNE_MODEL_${i}`],
      aiMode: resolveAiMode(process.env[`AI_MODE_${i}`])
    });
    i++;
  }

  // アカウントごとに少しずつ挙動をずらす(明示的に指定されていれば手動の値を優先)。
  // 全アカウントが全く同じタイミング・確率で動くと機械的に見えるため、
  // 何も設定しなくてもインデックスに応じて自動でクールダウンと返信確率をずらす。
  return accounts.map((acc, index) => ({
    ...acc,
    cooldownSeconds: acc.cooldownSecondsOverride ?? settings.cooldownSeconds + index * 15,
    replyChanceMultiplier: acc.replyChanceMultiplierOverride ?? 1 - index * 0.1
  }));
}

const env = {
  aiBaseUrl: process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
  aiApiKey: process.env.AI_API_KEY || process.env.GROQ_API_KEY,
  // 画像解析だけ別のAPI/モデルに投げたい場合用。未設定なら通常のAI接続先を使い回す
  visionBaseUrl: process.env.VISION_API_BASE_URL || process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1',
  visionApiKey: process.env.VISION_API_KEY || process.env.AI_API_KEY || process.env.GROQ_API_KEY
};

module.exports = {
  ...settings,
  env,
  selfTalkPrompt,
  readPersona,
  corpusPathFor,
  presenceFor,
  nicknames: loadNicknames(),
  accounts: loadAccounts()
};
