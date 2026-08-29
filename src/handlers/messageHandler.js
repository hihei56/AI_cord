const config = require('../utils/config');
const logger = require('../utils/logger');
const { getAIResponse, describeImage } = require('../utils/aiClient');
const { isOwnAccount } = require('../utils/ownAccounts');

// bot臭さ対策: 直近何件分の自分の発言をプロンプトの「これは避けて」に渡すか
const RECENT_REPLIES_MAX = 4;

// Tupperbox等のプロキシBotは、本人の発言を削除してwebhookで再送する仕組み。
// webhook経由のメッセージも author.bot が true になるが、本物のBotアカウント
// (webhookIdを持たない)とは区別し、実際の発言として扱う。
function isRealUser(message) {
  return !message.author.bot || Boolean(message.webhookId);
}

function isDuplicateBurst(sorted) {
  const { minGapMs } = config.recentDuplicateGuard;
  if (sorted.size < 2) return false;
  if (sorted.at(0).createdTimestamp - sorted.at(1).createdTimestamp < minGapMs) return true;
  return false;
}

// サーバーのシステムタイムゾーンに関係なく日本時間で判定したいので、
// new Date().getHours()(サーバーのローカル時刻、大抵UTC)ではなくUTCから明示的に計算する
function currentJstFractionalHour() {
  const now = new Date();
  const jstMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 9 * 60) % (24 * 60);
  return jstMinutes / 60;
}

// 日本人らしい生活リズム(深夜は寝てる、昼は控えめ、夜は活発)を時間帯ごとの
// 倍率テーブルで再現する。アカウントごとのoffset/energyで個体差もつける。
function activityMultiplier(state) {
  const { hourlyMultipliers } = config.activityRhythm || {};
  if (!hourlyMultipliers?.length) return 1;

  const fractionalHour = currentJstFractionalHour() + (state.activityOffsetHours ?? 0);
  const hour = ((Math.round(fractionalHour) % 24) + 24) % 24;

  return hourlyMultipliers[hour] * (state.activityEnergy ?? 1);
}

// 直近の発言者がcrowdGuard.minDistinctUsers人以上いたら「盛り上がってる人間の会話に
// わざわざ割り込まない」ようそっと返信確率を下げる
function crowdMultiplier(sortedMessages, selfId) {
  const { windowMs, minDistinctUsers, backoffMultiplier } = config.crowdGuard || {};
  if (!minDistinctUsers || !sortedMessages) return 1;

  const now = Date.now();
  const distinct = new Set();
  for (const m of sortedMessages.values()) {
    if (now - m.createdTimestamp > windowMs) break;
    if (m.author.id !== selfId) distinct.add(m.author.id);
  }

  return distinct.size >= minDistinctUsers ? backoffMultiplier : 1;
}

function resolveChance(msg, client, state, sortedMessages) {
  const isMention = msg.mentions.has(client.user.id);
  const isReply = msg.type === 'REPLY' && msg.reference?.messageId;

  let chance = config.replyChance.normal;
  if (isMention) chance = config.replyChance.mention;
  if (isReply) chance = config.replyChance.reply;

  chance *= activityMultiplier(state);
  // メンション・リプライで直接呼ばれた時は混雑してても普通に反応する
  if (!isMention && !isReply) chance *= crowdMultiplier(sortedMessages, client.user.id);

  return chance * (state.replyChanceMultiplier ?? 1);
}

function registerMessageHandler(client) {
  const state = client.accountState;

  client.on('messageCreate', async (msg) => {
    if (msg.author.id === client.user.id) return;
    // 兄弟アカウント(他の自分のアカウント)の発言には通常の確率ロジックで
    // 反応しない。両アカウントが互いに際限なく返信し続けるのを防ぐため。
    // 意図的な掛け合いは conversationSeedHandler が専用ルートで行う。
    if (isOwnAccount(msg.author.id)) return;
    if (state.lockedDown) return;
    if (msg.guild?.id !== state.allowedGuildId) return;
    if (!state.channelStore.isAllowedChannel(msg.channel.id)) return;
    if (!isRealUser(msg)) return;

    const now = Date.now();
    const cooldownSeconds = state.cooldownSeconds ?? config.cooldownSeconds;
    if (now - state.lastReplyTime < cooldownSeconds * 1000) return;

    let sorted;
    try {
      const fetchLimit = Math.max(config.recentDuplicateGuard.fetchLimit, config.crowdGuard?.fetchLimit ?? 0);
      const recent = await msg.channel.messages.fetch({ limit: fetchLimit });
      sorted = recent.filter(isRealUser).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      if (isDuplicateBurst(sorted)) return;
      if (sorted.size >= 2 && sorted.at(0).author.id === client.user.id) return;
    } catch {
      // ignore fetch failures, fall through to reply attempt
    }

    const chance = resolveChance(msg, client, state, sorted);
    if (Math.random() > chance) return;

    logger.log('TRIG', `[${state.id}] ${msg.author.username}: ${msg.content.slice(0, 30)}`);

    try {
      await msg.channel.sendTyping();

      const { minMs, maxMs } = config.typingDelay;
      await new Promise((r) => setTimeout(r, Math.random() * (maxMs - minMs) + minMs));

      const history = await msg.channel.messages.fetch({ limit: config.ai.reply.historyFetchLimit });
      const ctxMsgs = [...history.filter(isRealUser).reverse().values()];

      let userMsg = msg.content;
      const image = [...msg.attachments.values()].find((a) => a.contentType?.startsWith('image/'));
      if (image) {
        const description = await describeImage(image.url);
        if (description) userMsg = `${userMsg}\n[添付画像の内容: ${description}]`.trim();
      }

      // メンション/リプライで直接呼ばれた時はマルコフ直接採用を避け、ちゃんと文脈に沿った返信にする
      const isMention = msg.mentions.has(client.user.id);
      const isReply = msg.type === 'REPLY' && msg.reference?.messageId;
      const reply = await getAIResponse(state, userMsg, ctxMsgs, msg, { allowMarkovDirect: !isMention && !isReply });
      if (!reply) return;

      const { minMs: replyMinMs, perCharMs, capMs, jitterMs } = config.replyDelay;
      const typingMs = Math.max(replyMinMs, Math.min(reply.length * perCharMs, capMs));
      await new Promise((r) => setTimeout(r, typingMs + Math.random() * jitterMs));

      // msg.reply()だと相手にメンション通知が飛ぶ「リプライ」表示になり、それが毎回だと
      // いかにもbotっぽいので、普通のメッセージとして送る(会話履歴で文脈は伝わる)
      await msg.channel.send(reply);
      state.lastReplyTime = Date.now();
      state.recentReplies.push(reply);
      if (state.recentReplies.length > RECENT_REPLIES_MAX) state.recentReplies.shift();
      logger.log('REPLY', `[${state.id}] ${reply.slice(0, 50)}`);
    } catch (err) {
      logger.error('MESSAGE', err);
    }
  });
}

module.exports = { registerMessageHandler };
