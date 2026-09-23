// ご飯画像の定期投稿と、他BOTへのスラッシュコマンド自動送信(!slashbump)を行う
// 独立プロセス用エントリポイント。メインのai_cordプロセス(src/index.js)とは
// プロセス間通信を一切しない(どちらもアカウント固有のペルソナ・会話機能に
// 依存しない、完結した機能のため)。pm2でai_cordとは別プロセスとして起動する
// ことで、片方のクラッシュ・再起動がもう片方に波及しないようにする。
//
// 使うDiscordアカウントはMEALPOST_DISCORD_TOKEN(専用アカウント推奨。未設定なら
// DISCORD_TOKENを使い回す)と、MEALPOST_DISCORD_TOKEN_2, _3... の番号付きトークン。
// 全アカウントを1プロセスで同時に動かし、ご飯画像はアカウントごとに独立して投稿する
require('dotenv').config();

const { Client } = require('discord.js-selfbot-v13');
const logger = require('./utils/logger');
const config = require('./utils/config');
const { registerMealImageHandler } = require('./handlers/mealImageHandler');
const { registerSlashBumpHandler } = require('./handlers/slashBumpHandler');
const { canRunCommands } = require('./commands/handler');
const slashBumpCommand = require('./commands/slashbumpCommand');

// アカウント1は無印の変数名、2つ目以降は _N 付き。番号は飛んでいても拾う
function loadMealPostAccounts() {
  const env = process.env;
  const accounts = [];
  const firstToken = env.MEALPOST_DISCORD_TOKEN || env.DISCORD_TOKEN;
  if (firstToken) {
    accounts.push({
      id: '1',
      token: firstToken,
      prefix: env.MEALPOST_COMMAND_PREFIX,
      roleIds: env.MEALPOST_COMMAND_ROLE_ID,
      mealChannelId: env.MEALPOST_CHANNEL_ID,
      mealFolder: env.MEALPOST_IMAGE_FOLDER
    });
  }

  const numbers = Object.keys(env)
    .map((key) => key.match(/^MEALPOST_DISCORD_TOKEN_(\d+)$/)?.[1])
    .filter((n) => n && n !== '1' && env[`MEALPOST_DISCORD_TOKEN_${n}`])
    .map(Number)
    .sort((a, b) => a - b);

  for (const n of numbers) {
    accounts.push({
      id: String(n),
      token: env[`MEALPOST_DISCORD_TOKEN_${n}`],
      prefix: env[`MEALPOST_COMMAND_PREFIX_${n}`] || env.MEALPOST_COMMAND_PREFIX,
      roleIds: env[`MEALPOST_COMMAND_ROLE_ID_${n}`] || env.MEALPOST_COMMAND_ROLE_ID,
      mealChannelId: env[`MEALPOST_CHANNEL_ID_${n}`],
      mealFolder: env[`MEALPOST_IMAGE_FOLDER_${n}`]
    });
  }
  return accounts;
}

const accounts = loadMealPostAccounts();

if (accounts.length === 0) {
  logger.error('FATAL', 'MEALPOST_DISCORD_TOKENまたはDISCORD_TOKENが設定されていません');
  process.exit(1);
}

process.on('unhandledRejection', (err) => logger.error('UNHANDLED', err));
process.on('uncaughtException', (err) => logger.error('UNCAUGHT', err));

// 同じメッセージを複数アカウントが同時に受信するので、!slashbumpは最初に受け取った
// 1アカウントだけが処理する(slashbumpの設定は全アカウント共通のため1回で足りる)
const handledMessageIds = new Set();

function claimMessage(msgId) {
  if (handledMessageIds.has(msgId)) return false;
  handledMessageIds.add(msgId);
  if (handledMessageIds.size > 500) handledMessageIds.delete(handledMessageIds.values().next().value);
  return true;
}

function createMealPostClient(account) {
  const client = new Client({
    checkUpdate: false,
    syncStatus: true,
    ws: { properties: { $os: 'Windows', $browser: 'Discord Client', $device: 'Discord Client' } }
  });

  // このプロセスにはメインのai_cordのようなペルソナ・会話履歴等の状態は無いため、
  // !slashbumpコマンドの権限判定(canRunCommands)とご飯投稿に必要な最小限の項目だけを持たせる
  client.accountState = {
    id: account.id,
    commandPrefix: account.prefix || 'meshi!',
    commandRoleIds: config.resolveCommandRoleIds(account.roleIds),
    // 未設定ならconfig/settings.jsonのmealPosts.channelId / folderBaseを使う
    mealChannelId: account.mealChannelId,
    mealFolder: account.mealFolder,
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
      logger.log('COMMAND', `[MEALPOST ${account.id}] ${msg.author.username}のコマンドを権限なしで拒否 (${permission.reason})`);
      return;
    }
    if (!claimMessage(msg.id)) return;

    try {
      await slashBumpCommand.execute(msg, args, client);
      logger.log('COMMAND', `[MEALPOST ${account.id}] ${msg.author.username}が実行: ${commandName}`);
    } catch (err) {
      logger.error('COMMAND', err);
    }
  });

  return client;
}

const LOGIN_TIMEOUT_MS = 60000;

// 1アカウントのログイン失敗で他のアカウントまで止めないよう、ログインできた分だけで動かす
function loginAndWaitReady(account) {
  const client = createMealPostClient(account);
  return new Promise((resolve) => {
    // readyもエラーも来ないまま固まると他アカウントの起動まで止まるので、一定時間で諦める
    const timer = setTimeout(() => {
      logger.error('LOGIN', `[MEALPOST ${account.id}] ${LOGIN_TIMEOUT_MS / 1000}秒以内にreadyにならなかったためスキップ`);
      client.destroy();
      resolve(null);
    }, LOGIN_TIMEOUT_MS);
    client.once('ready', () => {
      clearTimeout(timer);
      logger.log('READY', `[MEALPOST ${account.id}] ${client.user.tag}`);
      // コマンドに無反応な時、そもそもそのサーバーに参加していない(メッセージを
      // 受信できていない)のかを切り分けられるよう、参加サーバーを出しておく
      const guilds = [...client.guilds.cache.values()].map((g) => `${g.name}(${g.id})`);
      logger.log('READY', `[MEALPOST ${account.id}] 参加サーバー${guilds.length}件: ${guilds.join(', ')}`);
      resolve(client);
    });
    client.login(account.token).catch((err) => {
      clearTimeout(timer);
      logger.error('LOGIN', `[MEALPOST ${account.id}] ${err.message}`);
      resolve(null);
    });
  });
}

(async () => {
  const clients = (await Promise.all(accounts.map(loginAndWaitReady))).filter(Boolean);
  if (clients.length === 0) {
    logger.error('FATAL', '[MEALPOST] ログインできたアカウントが1つも無い');
    process.exit(1);
  }
  logger.log('READY', `[MEALPOST] ${clients.length}/${accounts.length}アカウントで起動`);
  registerMealImageHandler(clients);
  registerSlashBumpHandler(clients);
})();
