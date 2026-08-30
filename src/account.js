const config = require('./utils/config');
const { createChannelStore } = require('./utils/channelStore');
const { createReminderStore } = require('./utils/reminderStore');

// アカウント1つ分の実行時状態(ペルソナ・コーパス・応答チャンネル・
// クールダウン・ロックダウン・マルコフ連鎖・リマインダー)をひとまとめにする。
// これをclientに紐付けることで、複数アカウントを同一プロセスで
// 動かしてもお互いの状態が混ざらないようにする。
function buildAccountState(account) {
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
    // !set mode で実行中に切り替えられる。markov: 今まで通りマルコフ下書き+Groq補正。
    // finetune: ファインチューニング済みモデルに直接投げる(下書き・ペルソナ文書は使わない)。
    // 起動時点の初期値は .env の AI_MODE[_N] で指定できる(未設定ならmarkov)
    aiMode: account.aiMode,
    finetuneBaseUrl: account.finetuneBaseUrl,
    finetuneApiKey: account.finetuneApiKey,
    finetuneModel: account.finetuneModel,
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
