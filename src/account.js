const config = require('./utils/config');
const { createChannelStore } = require('./utils/channelStore');
const { createReminderStore } = require('./utils/reminderStore');

// アカウントIDから0〜1の疑似乱数を作る(毎回起動しても同じ人物は同じリズムになるように、
// Math.randomではなくIDから決定的に算出する)
function seededFraction(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return (Math.abs(h) % 10000) / 10000;
}

// アカウント1つ分の実行時状態(ペルソナ・コーパス・応答チャンネル・
// クールダウン・ロックダウン・マルコフ連鎖・リマインダー)をひとまとめにする。
// これをclientに紐付けることで、複数アカウントを同一プロセスで
// 動かしてもお互いの状態が混ざらないようにする。
function buildAccountState(account) {
  const rhythm = config.activityRhythm || {};
  const maxOffset = rhythm.offsetJitterHours ?? 0;
  const [energyMin, energyMax] = rhythm.energyRange ?? [1, 1];

  return {
    id: account.id,
    discordToken: account.discordToken,
    allowedGuildId: account.allowedGuildId,
    personaName: account.personaName,
    persona: config.readPersona(account.personaName),
    corpusPath: config.corpusPathFor(account.corpusFile),
    presence: config.presenceFor(account.presenceFile),
    cooldownSeconds: account.cooldownSeconds,
    replyChanceMultiplier: account.replyChanceMultiplier,
    commandPrefix: account.commandPrefix,
    commandRoleIds: account.commandRoleIds,
    // 「人によって朝型/夜型が違う」を再現するための個体差。IDから決定的に算出するので
    // 再起動しても同じアカウントは同じ生活リズムを保つ
    activityOffsetHours: (seededFraction(`${account.id}-offset`) - 0.5) * 2 * maxOffset,
    activityEnergy: energyMin + seededFraction(`${account.id}-energy`) * (energyMax - energyMin),
    channelStore: createChannelStore(account.id, account.allowedChannelId),
    reminderStore: createReminderStore(account.id),
    lastReplyTime: 0,
    lockedDown: false,
    markovChain: null,
    // 直近の自分の発言を数件保持し、同じ感嘆詞・絵文字の組み合わせを連発しないよう
    // プロンプトに「これは避けて」として渡す(bot臭さ対策)
    recentReplies: []
  };
}

module.exports = { buildAccountState };
