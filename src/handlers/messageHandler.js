const config = require('../utils/config');
const logger = require('../utils/logger');
const { getAIResponse, describeImage, recordReply, recordMemory, compressUserMemoryIfNeeded } = require('../utils/aiClient');
const { isOwnAccount } = require('../utils/ownAccounts');
const { resolveDisplayName } = require('../utils/nicknames');
const { pickReactionEmoji } = require('../utils/reactionEmoji');
const { isEmojiGifOnlyMode, pickEmojiOrGif } = require('../utils/emojiGifReply');
const crowd = require('../utils/crowd');
const humanPresence = require('../utils/humanPresence');

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

// 返信生成用の会話履歴(古い→新しい順)。以前は返信1回ごとに、ガード判定用の
// fetch(上限20件)とは別に、タイピング待ちの後でもう一度fetch(10件)していた。
// ガード用fetchの時点でチャンネルのメッセージキャッシュは埋まっており、待っている間に
// 届いた新着もmessageCreate経由でキャッシュに積まれるので、キャッシュで足りる。
// セルフボットではAPI呼び出しの回数そのものがbot判定の材料になりうるため、
// 1返信あたりのAPI呼び出しを1回減らす。キャッシュが空に近い時(ガード用fetchが
// 失敗した等)だけ従来通りfetchする
async function recentHistory(channel, limit) {
  // 足りない時だけfetchする。fetchした分はキャッシュに入るので、以降は呼ばれない
  const source = channel.messages.cache.size >= limit ? channel.messages.cache : await channel.messages.fetch({ limit });
  return [...source.values()]
    .filter(isRealUser)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-limit);
}

// 連投・自分の連続返信の判定用に、直近の実ユーザーの発言を新しい順で返す。
// 判定に使うのは直近2件だけで、それはmessageCreateで受信済みなのでキャッシュで足りる。
// 起動直後などでキャッシュがほぼ空の時だけfetchする
async function recentSorted(channel, limit) {
  const source = channel.messages.cache.size >= 2 ? channel.messages.cache : await channel.messages.fetch({ limit });
  return [...source.values()].filter(isRealUser).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
}

function isDuplicateBurst(sorted) {
  const { minGapMs } = config.recentDuplicateGuard;
  if (sorted.length < 2) return false;
  return sorted[0].createdTimestamp - sorted[1].createdTimestamp < minGapMs;
}

// config.replyChanceの値(mention/reply/normal)は固定の定数なので、そのまま
// 使うと「外から見た反応率が常にきっちり同じ割合」になり、観測され続けると
// 機械的なパターンとして見えやすい(実際に「反応が規則的すぎる」と指摘された)。
// 判定のたびに±REPLY_CHANCE_JITTERの範囲でランダムに揺らして、人間の気分屋な
// 反応頻度のようにばらつきを持たせる
const REPLY_CHANCE_JITTER = 0.15;

function resolveChance(msg, client, state, presenceLevel) {
  const isMention = msg.mentions.has(client.user.id);
  const isReply = msg.type === 'REPLY' && msg.reference?.messageId;

  let chance = config.replyChance.normal;
  if (isMention) chance = config.replyChance.mention;
  if (isReply) chance = config.replyChance.reply;

  chance = Math.min(1, Math.max(0, chance * (1 + (Math.random() * 2 - 1) * REPLY_CHANCE_JITTER)));

  // 人間の人数でbotの出しゃばり具合を変える(humanPresence参照)。人間同士で回っている時は
  // 引っ込み、1人しかいない時は寂しくならないよう反応を増やす。
  // メンション・リプライで直接呼ばれた時は人数に関係なく普通に反応する
  if (!isMention && !isReply) chance = Math.min(1, chance * humanPresence.replyFactor(presenceLevel));

  // ユーザーが直接リプライしてきた時は、アカウントごとの確率ばらつき
  // (replyChanceMultiplier)も無視してほぼ確実に反応する(呼びかけられたのに
  // 無視するのは不自然なため)。ただしconfig側のreplyChance.replyを1未満に
  // 下げれば、上のジッターと合わせてごく稀に反応しないこともあり得るようにできる
  if (isReply) return chance;

  return chance * (state.replyChanceMultiplier ?? 1);
}

// リアクションは返信と違い後続の会話を生まない(新たなメッセージを発生させない)ため、
// 兄弟アカウント(他の自分のアカウント)の発言に対しても付けてよい。ただし本物の
// Bot(Dissoku等、自分たちのアカウント以外のbot)には毎回律儀に反応すると
// 不自然なので除外する。TupperboxのようなWebhookプロキシ経由の発言は実際の
// ユーザーの発言として扱う(isRealUserと同じ考え方)
function isReactableMessage(msg) {
  if (msg.author.bot && !msg.webhookId && !isOwnAccount(msg.author.id)) return false;
  return true;
}

const REACTION_CHANCE_JITTER = 0.4;

function resolveReactionChance() {
  const base = config.reactions?.chance ?? 0;
  const jitterRatio = config.reactions?.chanceJitter ?? REACTION_CHANCE_JITTER;
  return Math.min(1, Math.max(0, base * (1 + (Math.random() * 2 - 1) * jitterRatio)));
}

async function maybeReact(msg, state) {
  if (!config.reactions?.enabled) return;
  if (Math.random() > resolveReactionChance()) return;
  try {
    await msg.react(pickReactionEmoji(msg.content));
  } catch (err) {
    logger.error('REACTION', `[${state.id}] ${err.message}`);
  }
}

function registerMessageHandler(client) {
  const state = client.accountState;

  client.on('messageCreate', async (msg) => {
    if (msg.author.id === client.user.id) return;

    // リアクションだけは返信ロジック(cooldown・crowdGuard・兄弟アカウント除外等)とは
    // 独立して判定する。await を挟まないここまでのガードだけ満たせば良い軽量な処理なので、
    // 返信するかどうかの重い判定より先に済ませてしまう
    if (
      !state.lockedDown &&
      state.guildStore.isAllowedGuild(msg.guild?.id) &&
      isReactableMessage(msg) &&
      (Boolean(state.testChannelId) && msg.channel.id === state.testChannelId
        ? true
        : state.channelStore.isAllowedChannel(msg.channel.id))
    ) {
      maybeReact(msg, state).catch((err) => logger.error('REACTION', err));
    }

    // 兄弟アカウント(他の自分のアカウント)の発言には、ここから先の通常の返信確率
    // ロジックでは反応しない。両アカウントが互いに際限なく返信し続けるのを防ぐため。
    // 意図的な掛け合いは conversationSeedHandler が専用ルートで行う。
    if (isOwnAccount(msg.author.id)) return;
    if (state.lockedDown) return;
    // config/settings.jsonのaiPosting.enabled=falseでAIの返信を止める(リアクション・コマンドは別系統なので動く)
    if (config.aiPosting?.enabled === false) return;
    if (!state.guildStore.isAllowedGuild(msg.guild?.id)) return;
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

    // 確率判定を履歴の取得より先にする。以前は全アカウントが人間の発言のたびに
    // 履歴をfetch(Discord API呼び出し)してから確率判定していたため、アカウント数N
    // ×発言数のAPI呼び出しが発生し、その大半は確率で落ちて無駄になっていた。
    // 確率判定に必要な人数(humanPresence)はキャッシュだけで出せる
    const presenceLevel = humanPresence.level(msg.channel);
    const chance = isTestChannel ? 1 : resolveChance(msg, client, state, presenceLevel);
    if (Math.random() > chance) return;

    if (!isTestChannel) {
      try {
        const sorted = await recentSorted(msg.channel, Math.max(config.recentDuplicateGuard.fetchLimit, config.crowdGuard?.fetchLimit ?? 0));
        if (isDuplicateBurst(sorted)) return;
        if (sorted.length >= 2 && sorted[1].author.id === client.user.id) return;
      } catch {
        // ignore fetch failures, fall through to reply attempt
      }
    }

    // cooldownチェック(100行目)はここまでの間にawait(履歴fetch等)を挟んでいるため、
    // 別のメッセージが同時期に届くと両方とも古いlastReplyTimeを見て通過してしまい、
    // 同じアカウントから返信が2連続で送られることが稀にあった。ここでawaitを挟まず
    // 同期的に再チェック+即座に予約することで、以降の生成・送信が終わる前に
    // 他のイベントがすり抜けるのを防ぐ(Nodeはシングルスレッドなので、
    // このチェックと代入の間に他のmessageCreateハンドラが割り込むことはない)
    if (!isTestChannel && Date.now() - state.lastReplyTime < effectiveCooldownMs) return;

    // 同じ発言に複数アカウントが返信しようとした場合、最初の1つがlead(普通に返信)、
    // 2つ目以降はleadの返信に乗っかるfollowerになる(並行して別々の返信を投げない)
    const crowdRole = crowd.claim(msg.id, state.id, presenceLevel);
    if (crowdRole === 'none') return;
    if (crowdRole === 'follower') {
      crowd.follow(client, msg).catch((err) => logger.error('CROWD', err));
      return;
    }
    state.lastReplyTime = Date.now();

    logger.log('TRIG', `[${state.id}] ${msg.author.username}: ${msg.content.slice(0, 30)}`);

    let sentMsg = null;
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

      const ctxMsgs = await recentHistory(msg.channel, config.ai.reply.historyFetchLimit);

      let userMsg = msg.content;
      // 絵文字/GIFのみモードではLLMを一切呼ばないため、画像読み取り(vision API)も
      // 不要(読み取った説明文はLLMへの返信生成にしか使っていないため)
      if (!isEmojiGifOnlyMode()) {
        // visionモデルに一度に投げる画像枚数には上限がある(モデルによって受付枚数の
        // 上限が違い、4枚を超えるとエラーになったり後半が無視されたりする)ため、
        // 添付が多い時は先頭maxImages枚だけ読み取る
        const maxImages = config.ai.vision?.maxImages ?? 4;
        const imageUrls = extractImageUrls(msg).slice(0, maxImages);
        if (imageUrls.length > 0) {
          const description = await describeImage(imageUrls);
          if (description) userMsg = `${userMsg}\n[添付画像の内容: ${description}]`.trim();
        }
      }

      // メンション/リプライで直接呼ばれた時はマルコフ直接採用を避け、ちゃんと文脈に沿った返信にする
      const isMention = msg.mentions.has(client.user.id);
      const isReply = msg.type === 'REPLY' && msg.reference?.messageId;
      const reply = isEmojiGifOnlyMode()
        ? await pickEmojiOrGif(state, userMsg)
        : await getAIResponse(state, userMsg, ctxMsgs, msg, { allowMarkovDirect: !isMention && !isReply });
      if (!reply) return;

      const { minMs: replyMinMs, perCharMs, capMs, jitterMs } = config.replyDelay;
      const typingMs = Math.max(replyMinMs, Math.min(reply.length * perCharMs, capMs));
      await new Promise((r) => setTimeout(r, typingMs + Math.random() * jitterMs));

      // リプライ表示(誰への返信か分かるUI)は付けつつ、allowedMentions.repliedUserを
      // falseにしてメンション通知は飛ばさない「サイレントリプライ」にする。
      // 普通のmsg.reply()だと毎回通知が飛んでbotっぽく見えるが、通知無しなら
      // 会話の繋がりを見せつつ不自然さも出ない
      sentMsg = await msg.channel.send({
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
    } finally {
      // 失敗・見送りでも必ず呼ぶ(待っているfollowerを解放するため)
      crowd.leadDone(client, msg, sentMsg);
    }
  });
}

module.exports = { registerMessageHandler };
