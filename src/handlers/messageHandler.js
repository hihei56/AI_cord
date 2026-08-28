const config = require('../utils/config');
const logger = require('../utils/logger');
const { getAIResponse } = require('../utils/aiClient');

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

function resolveChance(msg, client) {
  const isMention = msg.mentions.has(client.user.id);
  const isReply = msg.type === 'REPLY' && msg.reference?.messageId;

  let chance = config.replyChance.normal;
  if (isMention) chance = config.replyChance.mention;
  if (isReply) chance = config.replyChance.reply;

  const hour = new Date().getHours();
  const { startHour, endHour, multiplier } = config.nightMode;
  if (hour >= startHour && hour <= endHour) chance *= multiplier;

  return chance;
}

function registerMessageHandler(client) {
  const state = client.accountState;

  client.on('messageCreate', async (msg) => {
    if (msg.author.id === client.user.id) return;
    if (state.lockedDown) return;
    if (msg.guild?.id !== state.allowedGuildId) return;
    if (!state.channelStore.isAllowedChannel(msg.channel.id)) return;
    if (!isRealUser(msg)) return;

    const now = Date.now();
    if (now - state.lastReplyTime < config.cooldownSeconds * 1000) return;

    try {
      const recent = await msg.channel.messages.fetch({ limit: config.recentDuplicateGuard.fetchLimit });
      const sorted = recent.filter(isRealUser).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      if (isDuplicateBurst(sorted)) return;
      if (sorted.size >= 2 && sorted.at(0).author.id === client.user.id) return;
    } catch {
      // ignore fetch failures, fall through to reply attempt
    }

    const chance = resolveChance(msg, client);
    if (Math.random() > chance) return;

    logger.log('TRIG', `[${state.id}] ${msg.author.username}: ${msg.content.slice(0, 30)}`);

    try {
      await msg.channel.sendTyping();

      const { minMs, maxMs } = config.typingDelay;
      await new Promise((r) => setTimeout(r, Math.random() * (maxMs - minMs) + minMs));

      const history = await msg.channel.messages.fetch({ limit: config.ai.reply.historyFetchLimit });
      const ctxMsgs = [...history.filter(isRealUser).reverse().values()];
      const reply = await getAIResponse(state, msg.content, ctxMsgs);
      if (!reply) return;

      const { perCharMs, capMs, jitterMs } = config.replyDelay;
      await new Promise((r) => setTimeout(r, Math.min(reply.length * perCharMs, capMs) + Math.random() * jitterMs));

      try {
        await msg.reply(reply);
      } catch (err) {
        // 返信遅延の間に元メッセージが消えている(Unknown message)などの場合は
        // 通常メッセージとして送り直す
        logger.error('REPLY-AS-REPLY', err);
        await msg.channel.send(reply);
      }
      state.lastReplyTime = Date.now();
      logger.log('REPLY', `[${state.id}] ${reply.slice(0, 50)}`);
    } catch (err) {
      logger.error('MESSAGE', err);
    }
  });
}

module.exports = { registerMessageHandler };
