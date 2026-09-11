// ご飯画像の定期投稿と、他BOTへのスラッシュコマンド自動送信(!slashbump)を行う
// 独立プロセス用エントリポイント。メインのai_cordプロセス(src/index.js)とは
// プロセス間通信を一切しない(どちらもアカウント固有のペルソナ・会話機能に
// 依存しない、完結した機能のため)。pm2でai_cordとは別プロセスとして起動する
// ことで、片方のクラッシュ・再起動がもう片方に波及しないようにする。
//
// 使うDiscordアカウントはMEALPOST_DISCORD_TOKEN(専用アカウント推奨)。
// 未設定ならDISCORD_TOKEN(ai_cordのアカウント1と同じ)を使い回す
require('dotenv').config();

const { Client } = require('discord.js-selfbot-v13');
const logger = require('./utils/logger');
const config = require('./utils/config');
const { registerMealImageHandler } = require('./handlers/mealImageHandler');
const { registerSlashBumpHandler } = require('./handlers/slashBumpHandler');
const { canRunCommands } = require('./commands/handler');
const slashBumpCommand = require('./commands/slashbumpCommand');

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

// このプロセスにはメインのai_cordのようなペルソナ・会話履歴等の状態は無いため、
// !slashbumpコマンドの権限判定(canRunCommands)に必要な最小限の項目だけを持たせる
client.accountState = {
  id: 'mealpost',
  commandPrefix: process.env.MEALPOST_COMMAND_PREFIX || 'meshi!',
  commandRoleIds: config.resolveCommandRoleIds(process.env.MEALPOST_COMMAND_ROLE_ID),
  lockedDown: false
};

// !slashbumpコマンドだけを受け付ける専用リスナー。ai_cordのcommands/handler.jsが
// 持つ汎用コマンドディスパッチ(全コマンドをロード)は使わず、このプロセスに
// 実際に関係するコマンドだけを直接呼ぶ(channel/nickname/pricealert等の
// 他コマンドはこのアカウントの状態を前提にしておらず対応する意味が無いため)
client.on('messageCreate', async (msg) => {
  const prefix = client.accountState.commandPrefix;
  if (!msg.content.startsWith(prefix)) return;

  const args = msg.content.slice(prefix.length).trim().split(/\s+/);
  const commandName = args.shift()?.toLowerCase();
  if (commandName !== 'slashbump' && commandName !== 'bump') return;

  const permission = await canRunCommands(msg, client, client.accountState);
  if (!permission.allowed) {
    logger.log('COMMAND', `[MEALPOST] ${msg.author.username}のコマンドを権限なしで拒否 (${permission.reason})`);
    return;
  }

  try {
    await slashBumpCommand.execute(msg, args, client);
    logger.log('COMMAND', `[MEALPOST] ${msg.author.username}が実行: ${commandName}`);
  } catch (err) {
    logger.error('COMMAND', err);
  }
});

client.once('ready', () => {
  logger.log('READY', `[MEALPOST] ${client.user.tag}`);
  registerMealImageHandler([client]);
  registerSlashBumpHandler([client]);
});

client.login(token).catch((err) => {
  logger.error('LOGIN', err);
  process.exit(1);
});
