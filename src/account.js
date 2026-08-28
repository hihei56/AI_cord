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
    channelStore: createChannelStore(account.id, account.allowedChannelId),
    reminderStore: createReminderStore(account.id),
    lastReplyTime: 0,
    lockedDown: false,
    markovChain: null
  };
}

module.exports = { buildAccountState };
