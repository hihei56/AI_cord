const config = require('../utils/config');
const logger = require('../utils/logger');
const { getAIResponse, describeImage, recordReply, recordMemory, compressUserMemoryIfNeeded } = require('../utils/aiClient');
const { isOwnAccount } = require('../utils/ownAccounts');
const { resolveDisplayName } = require('../utils/nicknames');

// Tupperbox等のプロキシBotは、本人の発言を削除してwebhookで再送する仕組み。
// webhook経由のメッセージも author.bot が true になるが、本物のBotアカウント
// (webhookIdを持たない)とは区別し、実際の発言として扱う。
function isRealUser(message) {
  return !message.author.bot || Boolean(message.webhookId);
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)(\?.*)?$/i;

// 添付ファイルのcontentTypeが取得できないことがある(セルフボット経由だと特に)ため、
// 拡張子でもフォールバック判定する。加えて、URLをそのまま貼った時にDiscordが自動生成する
// embed(image/thumbnail)からも拾う。複数画像添付にも対応するため全部集める
function extractImageUrls(msg) {
  const urls = [];
  for (const a of msg.attachments.values()) {
    if (a.contentType?.startsWith('image/') || IMAGE_EXT_RE.test(a.url || a.name || '')) {
      urls.push(a.url);
    }
  }
  for (const embed of msg.embeds || []) {
    const url = embed.image?.url || embed.thumbnail?.url;
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

function isDuplicateBurst(sorted) {
  const { minGapMs } = config.recentDuplicateGuard;
  if (sorted.size < 2) return false;
  if (sorted.at(0).createdTimestamp - sorted.at(1).createdTimestamp < minGapMs) return true;
  return false;
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

// config.replyChanceの値(mention/reply/normal)は固定の定数なので、そのまま
// 使うと「外から見た反応率が常にきっちり同じ割合」になり、観測され続けると
// 機械的なパターンとして見えやすい(実際に「反応が規則的すぎる」と指摘された)。
// 判定のたびに±REPLY_CHANCE_JITTERの範囲でランダムに揺らして、人間の気分屋な
// 反応頻度のようにばらつきを持たせる
const REPLY_CHANCE_JITTER = 0.15;

function resolveChance(msg, client, state, sortedMessages) {
  const isMention = msg.mentions.has(client.user.id);
  const isReply = msg.type === 'REPLY' && msg.reference?.messageId;

  let chance = config.replyChance.normal;
  if (isMention) chance = config.replyChance.mention;
  if (isReply) chance = config.replyChance.reply;

  chance = Math.min(1, Math.max(0, chance * (1 + (Math.random() * 2 - 1) * REPLY_CHANCE_JITTER)));

  // メンション・リプライで直接呼ばれた時は混雑してても普通に反応する
  if (!isMention && !isReply) chance *= crowdMultiplier(sortedMessages, client.user.id);

  // ユーザーが直接リプライしてきた時は、アカウントごとの確率ばらつき
  // (replyChanceMultiplier)も無視してほぼ確実に反応する(呼びかけられたのに
  // 無視するのは不自然なため)。ただしconfig側のreplyChance.replyを1未満に
  // 下げれば、上のジッターと合わせてごく稀に反応しないこともあり得るようにできる
  if (isReply) return chance;

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
    if (!isRealUser(msg)) return;
    if (state.allowedReplyUserIds?.length && !state.allowedReplyUserIds.includes(msg.author.id)) return;

    // テスト用チャンネルは応答チャンネル登録・クールダウン・確率・crowdGuardを
    // 全部無視して常に即応答する(動作確認用)。それ以外は今まで通りのガードを適用
    const isTestChannel = Boolean(state.testChannelId) && msg.channel.id === state.testChannelId;
    if (!isTestChannel && !state.channelStore.isAllowedChannel(msg.channel.id)) return;

    const now = Date.now();
    const cooldownSeconds = state.cooldownSeconds ?? config.cooldownSeconds;
    // クールダウンが毎回きっちり同じ長さだと機械的に見えるので、
    // 判定のたびに±cooldownJitterの範囲でランダムに揺らす
    const cooldownJitterRatio = config.cooldownJitter ?? 0.3;
    const effectiveCooldownMs = cooldownSeconds * 1000 * (1 + (Math.random() * 2 - 1) * cooldownJitterRatio);
    if (!isTestChannel && now - state.lastReplyTime < effectiveCooldownMs) return;

    let sorted;
    try {
      const fetchLimit = Math.max(config.recentDuplicateGuard.fetchLimit, config.crowdGuard?.fetchLimit ?? 0);
      const recent = await msg.channel.messages.fetch({ limit: fetchLimit });
      sorted = recent.filter(isRealUser).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      if (!isTestChannel) {
        if (isDuplicateBurst(sorted)) return;
        if (sorted.size >= 2 && sorted.at(1).author.id === client.user.id) return;
      }
    } catch {
      // ignore fetch failures, fall through to reply attempt
    }

    const chance = isTestChannel ? 1 : resolveChance(msg, client, state, sorted);
    if (Math.random() > chance) return;

    // cooldownチェック(100行目)はここまでの間にawait(履歴fetch等)を挟んでいるため、
    // 別のメッセージが同時期に届くと両方とも古いlastReplyTimeを見て通過してしまい、
    // 同じアカウントから返信が2連続で送られることが稀にあった。ここでawaitを挟まず
    // 同期的に再チェック+即座に予約することで、以降の生成・送信が終わる前に
    // 他のイベントがすり抜けるのを防ぐ(Nodeはシングルスレッドなので、
    // このチェックと代入の間に他のmessageCreateハンドラが割り込むことはない)
    if (!isTestChannel && Date.now() - state.lastReplyTime < effectiveCooldownMs) return;
    state.lastReplyTime = Date.now();

    logger.log('TRIG', `[${state.id}] ${msg.author.username}: ${msg.content.slice(0, 30)}`);

    try {
      const { minMs, maxMs, longPauseChance = 0, longPauseMinMs = 0, longPauseMaxMs = 0 } = config.typingDelay;

      // 毎回きっちり数秒後に反応すると機械的に見えるので、たまに長考の間を作る。
      // 長考中はtyping表示を出さず、実際に入力し始めるタイミングでsendTypingする
      if (longPauseChance > 0 && Math.random() < longPauseChance) {
        const silentMs = longPauseMinMs + Math.random() * (longPauseMaxMs - longPauseMinMs);
        await new Promise((r) => setTimeout(r, silentMs));
      }

      await msg.channel.sendTyping();
      await new Promise((r) => setTimeout(r, Math.random() * (maxMs - minMs) + minMs));

      const history = await msg.channel.messages.fetch({ limit: config.ai.reply.historyFetchLimit });
      const ctxMsgs = [...history.filter(isRealUser).reverse().values()];

      let userMsg = msg.content;
      const imageUrls = extractImageUrls(msg);
      if (imageUrls.length > 0) {
        const description = await describeImage(imageUrls);
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

      // リプライ表示(誰への返信か分かるUI)は付けつつ、allowedMentions.repliedUserを
      // falseにしてメンション通知は飛ばさない「サイレントリプライ」にする。
      // 普通のmsg.reply()だと毎回通知が飛んでbotっぽく見えるが、通知無しなら
      // 会話の繋がりを見せつつ不自然さも出ない
      await msg.channel.send({
        content: reply,
        reply: { messageReference: msg.id, failIfNotExists: false },
        allowedMentions: { repliedUser: false }
      });
      recordReply(state, reply);
      logger.log('REPLY', `[${state.id}] ${reply.slice(0, 50)}`);

      // 長期記憶: このやり取りを記録し、生ログが溜まっていれば要約する。
      // 返信を遅らせたくないのでawaitせずバックグラウンドで実行する
      const speakerLabel = resolveDisplayName(msg.author, msg.member);
      recordMemory(state, msg.author.id, speakerLabel, userMsg, reply);
      compressUserMemoryIfNeeded(state, msg.author.id, speakerLabel).catch((err) => logger.error('MEMORY', err));
    } catch (err) {
      logger.error('MESSAGE', err);
    }
  });
}

module.exports = { registerMessageHandler };
