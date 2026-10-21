const config = require('../utils/config');
const logger = require('../utils/logger');
const { convertTweetLinksInText } = require('../utils/vxtwitter');

// 転送先チャンネルにアクセスできる(参加している)最初のアカウントを使う。
// 転送元・転送先は普段の会話用チャンネルと別の場合もあるため、channelStoreには依らない
function findClientForChannel(clients, channelId) {
  return clients.find((c) => c.channels?.cache.get(channelId));
}

function relayDelay() {
  const { delayMs = 5000, delayJitter = 0.4 } = config.relay || {};
  return Math.max(0, delayMs * (1 + (Math.random() * 2 - 1) * delayJitter));
}

// 転送元チャンネルで連続して投稿があっても即座に全部転送せず、1件ずつ間隔を
// 空けて順番に処理する(機械的な連投に見えないようにするため)。
// キューはこのプロセス内の全転送で共有する
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch((err) => logger.error('RELAY', err));
  return queue;
}

// テキストはそのまま(コピペ)、添付ファイル・embed画像はDiscordのCDN URLを
// そのまま使う(ダウンロード/再アップロードは一切しない)。URLを本文に含めておけば
// Discord側が自動でプレビュー展開してくれる。ただしtwitter.com/x.com/nitter等の
// ツイートリンクだけはvxtwitter.com形式に変換する(生のツイートリンクだとDiscordの
// 埋め込みプレビューが展開されないため)
function buildRelayContent(msg) {
  const parts = [];
  if (msg.content) parts.push(convertTweetLinksInText(msg.content));
  for (const a of msg.attachments.values()) {
    if (a.url) parts.push(a.url);
  }
  for (const embed of msg.embeds || []) {
    const url = embed.image?.url || embed.thumbnail?.url || embed.video?.url;
    if (url) parts.push(url);
  }
  return parts.join('\n');
}

async function relayMessage(clients, destinationChannelIds, msg) {
  const content = buildRelayContent(msg);
  if (!content) return;

  for (const channelId of destinationChannelIds) {
    const client = findClientForChannel(clients, channelId);
    if (!client) {
      logger.error('RELAY', `転送先チャンネル${channelId}にアクセスできるアカウントが無い`);
      continue;
    }
    try {
      const channel = client.channels.cache.get(channelId);
      await channel.send(content);
      logger.log('RELAY', `[${client.accountState?.id ?? client.user?.id}] ${channel.name ?? channelId}へ転送`);
    } catch (err) {
      logger.error('RELAY', `${channelId}への転送に失敗: ${err.message}`);
    }
  }
}

// 直近見た転送元メッセージID。複数アカウントが同じ転送元チャンネルに参加していると
// メッセージごとに複数回messageCreateが発火し二重転送してしまうため、既に処理済みの
// メッセージは弾く
const seenMsgIds = new Set();
const SEEN_MAX = 200;

function alreadySeen(msgId) {
  if (seenMsgIds.has(msgId)) return true;
  seenMsgIds.add(msgId);
  if (seenMsgIds.size > SEEN_MAX) {
    const oldest = seenMsgIds.values().next().value;
    seenMsgIds.delete(oldest);
  }
  return false;
}

// 監視元・転送先・有効/無効はアカウントごとに設定する(client.accountState.relay、
// !relayコマンドで管理)。どのアカウントがどのチャンネルを監視するかはそのアカウントの
// 設定次第なので、全クライアントに登録した上でメッセージ受信のたびに「このクライアントの
// 監視元と一致するか」を都度見る(起動時点で設定が空でも、後から!relay sourceで
// 設定すれば再起動不要に効く)
function registerRelayHandler(clients) {
  for (const client of clients) {
    client.on('messageCreate', (msg) => {
      const relay = client.accountState?.relay;
      if (!relay?.enabled || !relay.sourceGuildId || !relay.sourceChannelId) return;
      if (msg.guild?.id !== relay.sourceGuildId || msg.channel.id !== relay.sourceChannelId) return;
      if (!relay.destinationChannelIds?.length) return;
      if (alreadySeen(msg.id)) return;

      enqueue(async () => {
        await relayMessage(clients, relay.destinationChannelIds, msg);
        await new Promise((r) => setTimeout(r, relayDelay()));
      });
    });
  }
}

module.exports = { registerRelayHandler };
