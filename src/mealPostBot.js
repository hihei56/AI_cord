// ご飯画像の定期投稿だけを行う独立プロセス用エントリポイント。
// メインのai_cordプロセス(src/index.js)とはプロセス間通信を一切しない
// (mealImageHandler自体が他アカウントとの連携を必要としない、完結した機能のため)。
// pm2でai_cordとは別プロセスとして起動することで、片方のクラッシュ・再起動が
// もう片方に波及しないようにする。
//
// 使うDiscordアカウントはMEALPOST_DISCORD_TOKEN(専用アカウント推奨)。
// 未設定ならDISCORD_TOKEN(ai_cordのアカウント1と同じ)を使い回す
require('dotenv').config();

const { Client } = require('discord.js-selfbot-v13');
const logger = require('./utils/logger');
const { registerMealImageHandler } = require('./handlers/mealImageHandler');

const token = process.env.MEALPOST_DISCORD_TOKEN || process.env.DISCORD_TOKEN;

if (!token) {
  logger.error('FATAL', 'MEALPOST_DISCORD_TOKENまたはDISCORD_TOKENが設定されていません');
  process.exit(1);
}

process.on('unhandledRejection', (err) => logger.error('UNHANDLED', err));
process.on('uncaughtException', (err) => logger.error('UNCAUGHT', err));

const client = new Client({
  checkUpdate: false,
  syncStatus: true,
  ws: { properties: { $os: 'Windows', $browser: 'Discord Client', $device: 'Discord Client' } }
});

client.once('ready', () => {
  logger.log('READY', `[MEALPOST] ${client.user.tag}`);
  registerMealImageHandler([client]);
});

client.login(token).catch((err) => {
  logger.error('LOGIN', err);
  process.exit(1);
});
