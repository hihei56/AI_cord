const config = require('../utils/config');
const logger = require('../utils/logger');
const { generateSelfTalk, getAIResponse, planConversationTopic, recordReply } = require('../utils/aiClient');
const { scheduleWithJitter } = require('../utils/scheduler');
const { isOwnAccount } = require('../utils/ownAccounts');
const { resolveDisplayName } = require('../utils/nicknames');

// AI同士の掛け合いで、相手を生のDiscordユーザー名(ログインハンドル)ではなく
// あだ名で呼び合わせる。優先順位はresolveDisplayNameと同じ
// (config/nicknames.jsonの個別登録 > そのサーバーのニックネーム > username)
function resolveBotDisplayName(client, channel) {
  const member = channel.guild?.members.cache.get(client.user.id);
  return resolveDisplayName(client.user, member);
}

const {
  checkIntervalMs: CHECK_INTERVAL_MS,
  checkIntervalJitter: CHECK_INTERVAL_JITTER = 0.4,
  alwaysOn: ALWAYS_ON,
  alwaysOnIntervalMs: ALWAYS_ON_INTERVAL_MS,
  quietThresholdMs: QUIET_THRESHOLD_MS = 600000,
  triggerChance: TRIGGER_CHANCE,
  minTurns: MIN_TURNS,
  maxTurns: MAX_TURNS,
  continueChance: CONTINUE_CHANCE,
  turnDelayMinMs: TURN_DELAY_MIN_MS,
  turnDelayMaxMs: TURN_DELAY_MAX_MS
} = config.conversationSeed;

// 本物のユーザー(botでも自アカウント群でもない)の発言か
function isRealUserMessage(msg) {
  return !msg.author.bot && !isOwnAccount(msg.author.id);
}

// チャンネルが「盛り上げ対象」かどうか。直近の発言(誰のものでも良い)が
// quietThresholdMs以上前なら対象。誰も一度も発言していない完全な無人チャンネルこそ
// 最優先で賑やかすべき対象なので、「直近の発言が見つからない」場合もtrue扱いにする
// (以前の実装は「人間の発言が見つからない」場合をfalse=対象外にしてしまっており、
// 一番賑やかしたい無人チャンネルが逆に除外されるバグだった)
async function isChannelQuiet(channel) {
  try {
    const recent = await channel.messages.fetch({ limit: 1 });
    const last = recent.first();
    if (!last) return true;
    return Date.now() - last.createdTimestamp > QUIET_THRESHOLD_MS;
  } catch {
    return false;
  }
}

function pickPair(clients) {
  const shuffled = [...clients].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
}

// alwaysOnモード用: ランダムではなく全アカウントを順繰りに回す。
// (0,1) → (1,2) → (2,3) → (3,0) → ... と隣接ペアを巡回することで、
// 特定のアカウントだけ喋り続けて他が放置される偏りを防ぎ、全アカウントが
// 均等に参加している「過熱感」を出す
let rotationIndex = 0;
function pickRotationPair(clients) {
  const a = clients[rotationIndex % clients.length];
  const b = clients[(rotationIndex + 1) % clients.length];
  rotationIndex = (rotationIndex + 1) % clients.length;
  return [a, b];
}

function sharedChannels(clientA, clientB) {
  return clientA.accountState.channelStore
    .listChannels()
    .filter((id) => clientB.accountState.channelStore.isAllowedChannel(id));
}

function randomTurnCount() {
  return MIN_TURNS + Math.floor(Math.random() * (MAX_TURNS - MIN_TURNS + 1));
}

function turnDelay() {
  return TURN_DELAY_MIN_MS + Math.random() * (TURN_DELAY_MAX_MS - TURN_DELAY_MIN_MS);
}

// typing表示を出してから即座に送信すると、応答が速い時は一瞬で消えて実質見えないため、
// 最低限これだけは表示され続けるよう間を空ける
const TYPING_MIN_VISIBLE_MS = 1500;

async function showTyping(channel, accountId) {
  try {
    await channel.sendTyping();
    await new Promise((r) => setTimeout(r, TYPING_MIN_VISIBLE_MS));
  } catch (err) {
    logger.error('SEED', `[${accountId}] typing表示に失敗: ${err.message}`);
  }
}

// sinceTimestamp以降に人間の発言が無いか確認する(掛け合いの途中でユーザーが
// 割り込んできたら打ち切って人間の話に譲るため)
async function humanInterruptedSince(client, channelId, sinceTimestamp) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return false;
  try {
    const recent = await channel.messages.fetch({ limit: 5 });
    return [...recent.values()].some((m) => m.createdTimestamp > sinceTimestamp && isRealUserMessage(m));
  } catch {
    return false;
  }
}

// 進行中の掛け合いがあるチャンネルID。alwaysOnモードは短い間隔で次のfn()が
// 発火するが、1回の掛け合いは複数ターン×turnDelayぶん時間がかかるため、
// このロックが無いと同じチャンネルで2つの掛け合いが同時進行してしまい、
// 互いのlastSentMsgが入れ替わって「直近メッセージではない古いメッセージへの
// リプライ」が発生する(Aの返信を送った直後にBが割り込んで投稿し、その後
// Aの次のターンが本来の直前メッセージ=Aの前回発言に返信すると、実際の
// チャンネル最新メッセージはB由来のものになっているため見た目がズレる)
const activeChannels = new Set();

// 過疎ぎみのチャンネルでAI同士に何度か掛け合いをさせて連投気味に会話を起こす。
// 通常のmessageCreateトリガーは経由しない(お互いに際限なく反応し合うのを防ぐため)。
// 途中でユーザーが発言してきたら打ち切り、通常のmessageHandler(人間には普通に反応する)に譲る
async function seedConversation(clientA, clientB, channelId) {
  if (activeChannels.has(channelId)) return;

  const channelA = clientA.channels.cache.get(channelId);
  if (!channelA) return;

  activeChannels.add(channelId);
  try {
    await runSeedConversation(clientA, clientB, channelId, channelA);
  } finally {
    activeChannels.delete(channelId);
  }
}

async function runSeedConversation(clientA, clientB, channelId, channelA) {
  await showTyping(channelA, clientA.accountState.id);

  // 各ターンをその場しのぎで生成すると「そうだね」の連発のような浅い応酬に
  // なりがちなので、会話を始める前に一度お題を決めて全ターンで共有する。
  // 失敗してもnullのまま(お題無し)で従来通り進行する
  const topicHint = await planConversationTopic(clientA.accountState.persona, clientB.accountState.persona);
  if (topicHint) logger.log('SEED', `[${clientA.accountState.id}⇄${clientB.accountState.id}] お題: ${topicHint}`);

  // この会話での役割分担: 両者が同じように話題を出そうとして噛み合わなかったり、
  // 逆にお互い相槌ばかりで話が広がらなかったりするのを防ぐため、話を切り出す側
  // (clientA=opener)を「話題を広げる中心役」、受け止める側(clientB)を
  // 「聞き役・相槌役」に固定する。ペア自体はpickPair/pickRotationPairで毎回
  // 入れ替わるため、長期的にはどのアカウントも両方の役を経験する
  const roleOf = (client) => (client === clientA ? 'center' : 'reactor');

  const opener = await generateSelfTalk(clientA.accountState, topicHint, 'center');
  if (!opener) return;

  const openerMsg = await channelA.send(opener);
  recordReply(clientA.accountState, opener);
  logger.log('SEED', `[${clientA.accountState.id}] ${opener}`);

  const history = [{ author: { username: resolveBotDisplayName(clientA, channelA) }, content: opener }];
  let speaker = clientB;
  let listener = clientA;
  let lastMsg = opener;
  let lastActionAt = Date.now();
  // 直前に送信したメッセージ。次のターンでDiscordのリプライ機能を使って
  // 参照することで、AI同士の掛け合いも実際の会話らしく繋がって見えるようにする
  let lastSentMsg = openerMsg;

  const totalTurns = randomTurnCount();

  for (let turn = 1; turn < totalTurns; turn++) {
    if (speaker.accountState.lockedDown) break;

    await new Promise((r) => setTimeout(r, turnDelay()));

    if (await humanInterruptedSince(speaker, channelId, lastActionAt)) {
      logger.log('SEED', `[${speaker.accountState.id}] ユーザーの発言を検知したため掛け合いを中断`);
      break;
    }

    const channel = speaker.channels.cache.get(channelId);
    if (!channel) break;

    await showTyping(channel, speaker.accountState.id);

    // 相手(listener)は人間ではなく別のAIアカウントなので、それをプロンプトに明示する。
    // 呼びかける名前は生のusernameではなくあだ名(サーバーニックネーム等)を使う
    const reply = await getAIResponse(speaker.accountState, lastMsg, history, null, {
      partnerIsAi: true,
      speakerLabelOverride: resolveBotDisplayName(listener, channel),
      topicHint,
      role: roleOf(speaker)
    });
    if (!reply) break;

    // 直前のメッセージへのリプライとして送る(失敗しても普通の投稿として送れれば良いので
    // failIfNotExists: falseにし、参照先が既に削除されていてもエラーにしない)
    lastSentMsg = await channel.send({
      content: reply,
      reply: { messageReference: lastSentMsg.id, failIfNotExists: false }
    });
    recordReply(speaker.accountState, reply);
    logger.log('SEED', `[${speaker.accountState.id}] ${reply}`);

    history.push({ author: { username: resolveBotDisplayName(speaker, channel) }, content: reply });
    lastMsg = reply;
    lastActionAt = Date.now();

    [speaker, listener] = [listener, speaker];

    // 最低ターン数を超えたら確率で切り上げる(毎回律儀に上限まで続くと不自然)
    if (turn + 1 >= MIN_TURNS && Math.random() > CONTINUE_CHANCE) break;
  }
}

// AIだけで常時チャットを動かす(config/settings.jsonのconversationSeed.alwaysOn)モード。
// 有効な場合、trigger確率・過疎チェックを無視して、より短い間隔(alwaysOnIntervalMs)で
// 必ず誰かのペアがどこかのチャンネルで会話を始める
function registerConversationSeedHandler(clients) {
  if (clients.length < 2) return;

  const intervalMs = ALWAYS_ON ? ALWAYS_ON_INTERVAL_MS || CHECK_INTERVAL_MS : CHECK_INTERVAL_MS;

  // setIntervalの完全固定周期だとチェックタイミングが規則的になるため、
  // ここも毎回ランダムな待機時間で次回をスケジュールする
  scheduleWithJitter(intervalMs, CHECK_INTERVAL_JITTER, async () => {
    if (!ALWAYS_ON && Math.random() > TRIGGER_CHANCE) return;

    const [clientA, clientB] = ALWAYS_ON ? pickRotationPair(clients) : pickPair(clients);
    if (!clientA?.user || !clientB?.user) return;
    if (clientA.accountState.lockedDown || clientB.accountState.lockedDown) return;

    const channels = sharedChannels(clientA, clientB);
    for (const channelId of channels) {
      const channel = clientA.channels.cache.get(channelId);
      if (!channel) continue;
      if (ALWAYS_ON || (await isChannelQuiet(channel))) {
        // awaitせずファイア&フォーゲットにする: ここでawaitすると1つの掛け合いが
        // 終わるまで次のスケジュールが始まらず直列になってしまい、alwaysOnで
        // 短い間隔を設定しても複数の掛け合いが同時進行せず賑やかさが出ない
        seedConversation(clientA, clientB, channelId).catch((err) => logger.error('SEED', err));
        break;
      }
    }
  });
}

module.exports = { registerConversationSeedHandler };
