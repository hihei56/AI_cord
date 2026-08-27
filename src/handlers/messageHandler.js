const config = require('../utils/config');
const logger = require('../utils/logger');
const { getAIResponse } = require('../utils/aiClient');

let lastReplyTime = 0;

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
  client.on('messageCreate', async (msg) => {
    if (msg.author.id === client.user.id) return;
    if (msg.guild?.id !== config.env.allowedGuildId) return;
    if (msg.channel.id !== config.env.allowedChannelId) return;
    if (msg.author.bot) return;

    const now = Date.now();
    if (now - lastReplyTime < config.cooldownSeconds * 1000) return;

    try {
      const recent = await msg.channel.messages.fetch({ limit: config.recentDuplicateGuard.fetchLimit });
      const sorted = recent.filter((m) => !m.author.bot).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      if (isDuplicateBurst(sorted)) return;
      if (sorted.size >= 2 && sorted.at(0).author.id === client.user.id) return;
    } catch {
      // ignore fetch failures, fall through to reply attempt
    }

    const chance = resolveChance(msg, client);
    if (Math.random() > chance) return;

    logger.log('TRIG', `${msg.author.username}: ${msg.content.slice(0, 30)}`);
    await msg.channel.sendTyping();

    const { minMs, maxMs } = config.typingDelay;
    await new Promise((r) => setTimeout(r, Math.random() * (maxMs - minMs) + minMs));

    const history = await msg.channel.messages.fetch({ limit: config.ai.reply.historyFetchLimit });
    const ctxMsgs = history.filter((m) => !m.author.bot).reverse();
    const reply = await getAIResponse(msg.content, ctxMsgs);
    if (!reply) return;

    const { perCharMs, capMs, jitterMs } = config.replyDelay;
    await new Promise((r) => setTimeout(r, Math.min(reply.length * perCharMs, capMs) + Math.random() * jitterMs));

    await msg.reply(reply);
    lastReplyTime = Date.now();
    logger.log('REPLY', reply.slice(0, 50));
  });
}

module.exports = { registerMessageHandler };
