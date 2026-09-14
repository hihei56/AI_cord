// ご飯画像の定期投稿、他BOTへのスラッシュコマンド自動送信(!slashbump)、
// チャンネル転送(relay)、RSSフィード経由のツイートリンク自動投稿(rssTwitterPost)、
// 検索キーワードのGIFを定期投稿(gifPost)を行う独立プロセス用エントリポイント。
// メインのai_cordプロセス(src/index.js)とは
// プロセス間通信を一切しない(どちらもアカウント固有のペルソナ・会話機能に
// 依存しない、完結した機能のため)。pm2でai_cordとは別プロセスとして起動する
// ことで、片方のクラッシュ・再起動がもう片方に波及しないようにする。
//
// ai_cordのDISCORD_TOKEN[_N]と同じ考え方で、MEALPOST_DISCORD_TOKEN(無印)に加えて
// MEALPOST_DISCORD_TOKEN_2, _3... で2体目以降のアカウントを同一プロセスに追加できる。
// 無印だけ設定されていれば(後方互換で)今まで通り1アカウントだけで動く
require('dotenv').config();

const { Client } = require('discord.js-selfbot-v13');
const logger = require('./utils/logger');
const config = require('./utils/config');
const { registerMealImageHandler } = require('./handlers/mealImageHandler');
const { registerSlashBumpHandler } = require('./handlers/slashBumpHandler');
const { registerRelayHandler } = require('./handlers/relayHandler');
const { registerRssTwitterPostHandler } = require('./handlers/rssTwitterPostHandler');
const { registerGifPostHandler } = require('./handlers/gifPostHandler');
const gifGenreStore = require('./utils/gifGenreStore');
const relayStore = require('./utils/relayStore');
const rssFeedStore = require('./utils/rssFeedStore');
const { canRunCommands } = require('./commands/handler');
const slashBumpCommand = require('./commands/slashbumpCommand');
const gifgenreCommand = require('./commands/core/gifgenre');
const relayCommand = require('./commands/relayCommand');
const rssfeedCommand = require('./commands/rssfeedCommand');

function idListEnv(envVal) {
  if (!envVal) return [];
  return envVal.split(',').map((id) => id.trim()).filter(Boolean);
}

function loadMealpostAccounts() {
  const accounts = [];

  // 1体目: 専用トークン未設定ならai_cordのアカウント1(DISCORD_TOKEN)を使い回す(既存の後方互換仕様)
  const firstToken = process.env.MEALPOST_DISCORD_TOKEN || process.env.DISCORD_TOKEN;
  if (firstToken) {
    accounts.push({
      id: 'mealpost',
      discordToken: firstToken,
      commandPrefix: process.env.MEALPOST_COMMAND_PREFIX || 'meshi!',
      commandRoleIds: config.resolveCommandRoleIds(process.env.MEALPOST_COMMAND_ROLE_ID),
      rssFeedUrls: idListEnv(process.env.RSS_FEED_URL),
      rssPostChannelId: process.env.RSS_POST_CHANNEL_ID,
      relaySourceGuildId: process.env.RELAY_SOURCE_GUILD_ID,
      relaySourceChannelId: process.env.RELAY_SOURCE_CHANNEL_ID,
      relayDestinationChannelIds: idListEnv(process.env.RELAY_DESTINATION_CHANNEL_IDS),
      // 注意: ai_cord本体のアカウント1もGIF_GENRE(無印)を使うため、mealpost側は
      // 同じ.envを共有しても衝突しないようMEALPOST_プレフィックス付きの専用変数にする
      gifGenres: idListEnv(process.env.MEALPOST_GIF_GENRE),
      gifPostChannelId: process.env.MEALPOST_GIF_POST_CHANNEL_ID
    });
  }

  let i = 2;
  while (process.env[`MEALPOST_DISCORD_TOKEN_${i}`]) {
    accounts.push({
      id: `mealpost${i}`,
      discordToken: process.env[`MEALPOST_DISCORD_TOKEN_${i}`],
      commandPrefix: process.env[`MEALPOST_COMMAND_PREFIX_${i}`] || 'meshi!',
      commandRoleIds: config.resolveCommandRoleIds(process.env[`MEALPOST_COMMAND_ROLE_ID_${i}`]),
      rssFeedUrls: idListEnv(process.env[`RSS_FEED_URL_${i}`]),
      rssPostChannelId: process.env[`RSS_POST_CHANNEL_ID_${i}`],
      relaySourceGuildId: process.env[`RELAY_SOURCE_GUILD_ID_${i}`],
      relaySourceChannelId: process.env[`RELAY_SOURCE_CHANNEL_ID_${i}`],
      relayDestinationChannelIds: idListEnv(process.env[`RELAY_DESTINATION_CHANNEL_IDS_${i}`]),
      gifGenres: idListEnv(process.env[`MEALPOST_GIF_GENRE_${i}`]),
      gifPostChannelId: process.env[`MEALPOST_GIF_POST_CHANNEL_ID_${i}`]
    });
    i++;
  }

  return accounts;
}

const accounts = loadMealpostAccounts();

if (accounts.length === 0) {
  logger.error('FATAL', 'MEALPOST_DISCORD_TOKENまたはDISCORD_TOKENが設定されていません');
  process.exit(1);
}

process.on('unhandledRejection', (err) => logger.error('UNHANDLED', err));
process.on('uncaughtException', (err) => logger.error('UNCAUGHT', err));

const clients = accounts.map((account) => {
  const client = new Client({
    checkUpdate: false,
    syncStatus: true,
    ws: { properties: { $os: 'Windows', $browser: 'Discord Client', $device: 'Discord Client' } }
  });

  // このプロセスにはメインのai_cordのようなペルソナ・会話履歴等の状態は無いため、
  // !slashbumpコマンドの権限判定(canRunCommands)・rssTwitterPostHandler・relayHandler・
  // gifPostHandlerに必要な最小限の項目だけを持たせる。gifGenres/relay/rssFeedは
  // いずれも初回起動時の.env値を初期値としてdata/配下に永続化し、以降はコマンドで
  // 管理する(ai_cord本体のアカウントと同じ仕組み)
  client.accountState = {
    id: account.id,
    commandPrefix: account.commandPrefix,
    commandRoleIds: account.commandRoleIds,
    lockedDown: false,
    rssFeed: rssFeedStore.loadOrInit(account.id, {
      enabled: true,
      feedUrls: account.rssFeedUrls || [],
      postChannelId: account.rssPostChannelId || null
    }),
    relay: relayStore.loadOrInit(account.id, {
      enabled: Boolean(account.relaySourceGuildId && account.relaySourceChannelId),
      sourceGuildId: account.relaySourceGuildId || null,
      sourceChannelId: account.relaySourceChannelId || null,
      destinationChannelIds: account.relayDestinationChannelIds || []
    }),
    gifGenres: gifGenreStore.loadOrInit(account.id, account.gifGenres || []),
    gifPostChannelId: account.gifPostChannelId
  };

  // !slashbump/!gifgenre/!relay/!rssfeedコマンドだけを受け付ける専用リスナー。
  // ai_cordのcommands/handler.jsが持つ汎用コマンドディスパッチ(全コマンドをロード)は
  // 使わず、このプロセスに実際に関係するコマンドだけを直接呼ぶ(channel/nickname/
  // pricealert等の他コマンドはこのアカウントの状態を前提にしておらず対応する意味が無いため)。
  // コマンドを実行したアカウント自身のclient.accountStateに紐づくため、「特定チャンネル
  // 監視は1個目のアカウントで、RSSは2個目のアカウントで」のように、コマンドを打つ
  // アカウント(prefixで区別)ごとに別々の設定を持たせられる
  const COMMANDS = {
    slashbump: slashBumpCommand,
    bump: slashBumpCommand,
    gifgenre: gifgenreCommand,
    gif: gifgenreCommand,
    relay: relayCommand,
    rssfeed: rssfeedCommand,
    rss: rssfeedCommand
  };

  client.on('messageCreate', async (msg) => {
    const prefix = client.accountState.commandPrefix;
    if (!msg.content.startsWith(prefix)) return;

    const args = msg.content.slice(prefix.length).trim().split(/\s+/);
    const commandName = args.shift()?.toLowerCase();
    const command = COMMANDS[commandName];
    if (!command) return;

    const permission = await canRunCommands(msg, client, client.accountState);
    if (!permission.allowed) {
      logger.log('COMMAND', `[${client.accountState.id}] ${msg.author.username}のコマンドを権限なしで拒否 (${permission.reason})`);
      return;
    }

    try {
      await command.execute(msg, args, client);
      logger.log('COMMAND', `[${client.accountState.id}] ${msg.author.username}が実行: ${commandName}`);
    } catch (err) {
      logger.error('COMMAND', err);
    }
  });

  return client;
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 以前(readyを一定時間待って来なければプロセスごとFATAL終了→pm2に再起動させる)は、
// サーバー負荷等でDiscord側のハンドシェイクが長引くケースでタイムアウト→強制終了→
// pm2再起動(=接続をゼロからやり直し)を繰り返すクラッシュループになってしまった
// (2分に延ばしても再現した)。login()自体が失敗(トークン不正等)した場合を除き、
// readyになるまでの時間はプロセスを生かしたまま無期限に待つ(ai_cord本体と同じ方針)。
// slashbump/relay/rssTwitterPostはチャンネルIDからアクセスできるアカウントを
// 実行のたびに動的に探す作りなので、登録時点で全アカウントがready済みである
// 必要は無い(readyになっていないアカウントは単にそのチャンネルにアクセスできない
// 扱いになるだけで、後から追いつく)
let handlersRegistered = false;
function registerSharedHandlersOnce() {
  if (handlersRegistered) return;
  handlersRegistered = true;
  registerMealImageHandler(clients);
  registerSlashBumpHandler(clients);
  registerRelayHandler(clients);
  registerRssTwitterPostHandler(clients);
}

for (const client of clients) {
  client.once('ready', () => {
    logger.log('READY', `[${client.accountState.id}] ${client.user.tag}`);
    registerSharedHandlersOnce();
    // gifPostHandlerはこのアカウント単体のgifGenres/gifPostChannelIdだけを見るので、
    // 複数アカウントを跨いだ待ち合わせ不要。readyになったアカウントから順次登録する
    registerGifPostHandler(client);
  });
}

// ai_cord本体のloginStaggered()と同じ方針: 複数アカウントを同時にlogin()すると
// 「別々のはずの複数アカウントが寸分違わず同時にオフライン→オンラインを繰り返す」
// という分かりやすいパターンになってしまうため、1アカウントずつランダムな間隔を
// 空けて順にログインする。login()自体の失敗(トークン不正等)はここでログに残す
async function start() {
  const { minMs = 8000, maxMs = 30000 } = config.loginStagger || {};

  for (let i = 0; i < clients.length; i++) {
    if (i > 0) await sleep(minMs + Math.random() * (maxMs - minMs));

    try {
      await clients[i].login(accounts[i].discordToken);
    } catch (err) {
      logger.error('LOGIN', `[${accounts[i].id}] ${err.message}`);
    }
  }
}

start();
