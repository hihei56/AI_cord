const config = require('./config');
const logger = require('./logger');
const { getAllClients } = require('./accountRegistry');
const usageLedger = require('./usageLedger');
const { resolveDisplayName } = require('./nicknames');
const { isEmojiGifOnlyMode, pickEmojiOrGif } = require('./emojiGifReply');

// 複数アカウントが「同じ場に同時にいる」感じを出すための調整役。
//
// 以前は人間の発言に対して各アカウントがバラバラに返信判定をしていたため、
// 2アカウントが同じ発言に返信しても互いを無視した並行の独り言になり、
// 「複数人がいる」ではなく「botが2体いる」ように見えていた。ここでは
// 1つの人間の発言につき返信役(lead)を1アカウントに決め、他のアカウントは
// leadの返信に乗っかる(ツッコむ・同意する・人間に別角度で返す)追従役(follower)にする。
// followerはleadが入力中の時点から入力中表示を出すので、Discord上では
// 「〇〇と△△が入力中…」と複数人が同時に打っている状態が見える
const CROWD = {
  followChance: 0.45,
  maxFollowers: 2,
  followDelayMinMs: 3000,
  followDelayMaxMs: 15000,
  replyToHumanChance: 0.3,
  ...(config.crowd || {})
};

// 人間の発言ID → { leadId, followers:Set, resolve, promise, done }
const sessions = new Map();

function session(messageId) {
  let s = sessions.get(messageId);
  if (!s) {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    s = { leadId: null, followers: new Set(), resolve, promise, done: false };
    sessions.set(messageId, s);
    setTimeout(() => sessions.delete(messageId), 10 * 60000).unref();
  }
  return s;
}

// 返信すると決めたアカウントが呼ぶ。最初に呼んだアカウントがlead、以降はfollower(上限あり)。
// 同期的に判定する(awaitを挟まない)ので、同時に呼ばれても2つのleadにはならない
function claim(messageId, accountId) {
  const s = session(messageId);
  if (!s.leadId) {
    s.leadId = accountId;
    return 'lead';
  }
  if (s.leadId === accountId || s.followers.has(accountId) || s.followers.size >= CROWD.maxFollowers) return 'none';
  s.followers.add(accountId);
  return 'follower';
}

// leadが返信を送った(sentMsg)/諦めた(null)時に必ず呼ぶ。待っているfollowerを起こし、
// さらに返信判定を通っていない兄弟アカウントにもfollowChanceで乗っからせる
function leadDone(leadClient, humanMsg, sentMsg) {
  const s = session(humanMsg.id);
  if (s.done) return;
  s.done = true;
  s.resolve(sentMsg || null);
  if (!sentMsg) return;

  for (const c of getAllClients()) {
    if (s.followers.size >= CROWD.maxFollowers) break;
    if (c === leadClient || !canParticipate(c, humanMsg.channel.id)) continue;
    if (s.followers.has(c.accountState.id) || Math.random() > CROWD.followChance) continue;
    s.followers.add(c.accountState.id);
    follow(c, humanMsg).catch((err) => logger.error('CROWD', err));
  }
}

function canParticipate(client, channelId) {
  const st = client.accountState;
  return (
    client.user &&
    !st.lockedDown &&
    config.aiPosting?.enabled !== false &&
    (st.channelStore.isAllowedChannel(channelId) || st.testChannelId === channelId)
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// leadの返信に乗っかる。leadが入力中のうちから入力中表示を出して「同時に打っている」状態を作る
async function follow(client, humanMsg) {
  const state = client.accountState;
  const channel = client.channels.cache.get(humanMsg.channel.id);
  if (!channel) return;
  state.lastReplyTime = Date.now();
  await channel.sendTyping().catch(() => {});

  const leadMsg = await Promise.race([session(humanMsg.id).promise, sleep(120000).then(() => null)]);
  if (!leadMsg || !canParticipate(client, channel.id)) return;

  await sleep(CROWD.followDelayMinMs + Math.random() * (CROWD.followDelayMaxMs - CROWD.followDelayMinMs));
  await channel.sendTyping().catch(() => {});

  // 遅延requireで循環参照を避ける(aiClient → usageLedger → … の読み込み順の都合)
  const { getAIResponse, recordReply } = require('./aiClient');
  const toHuman = Math.random() < CROWD.replyToHumanChance;
  const leadName = resolveDisplayName(leadMsg.author, leadMsg.member);

  // 追従の返信はバックグラウンド扱いにして、Logfare等の逃がし先(無ければ上限つき)で生成する。
  // 人間の発言1件につきLLM呼び出しが最大3回に増えるため、人間への返信用の枠を守る
  const text = isEmojiGifOnlyMode()
    ? await pickEmojiOrGif(state, leadMsg.content)
    : await usageLedger.runBackground(() =>
        toHuman
          ? getAIResponse(state, humanMsg.content, [humanMsg, leadMsg], humanMsg, { allowMarkovDirect: false })
          : getAIResponse(state, leadMsg.content, [humanMsg, leadMsg], null, {
              partnerIsAi: true,
              speakerLabelOverride: leadName,
              role: 'reactor'
            })
      );
  if (!text) return;

  const target = toHuman ? humanMsg : leadMsg;
  await channel.send({
    content: text,
    reply: { messageReference: target.id, failIfNotExists: false },
    allowedMentions: { repliedUser: false }
  });
  recordReply(state, text);
  logger.log('CROWD', `[${state.id}] ${toHuman ? '人間に' : `${leadName}に`}乗っかり: ${text.slice(0, 50)}`);
}

module.exports = { claim, leadDone, follow, canParticipate, CROWD };
