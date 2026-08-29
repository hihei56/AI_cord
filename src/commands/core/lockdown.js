const logger = require('../../utils/logger');
const { parseUserMention } = require('../mentionUtils');

module.exports = {
  name: 'lockdown',
  aliases: ['ロックダウン', 'pause'],
  description: '自動応答・自発投稿を緊急停止/再開する。複数アカウント運用中にロール経由で実行する時は !pause @account で対象を指定',
  async execute(msg, args, client) {
    const isSelf = msg.author.id === client.user.id;
    const targetUserId = parseUserMention(args[0]);

    if (!isSelf) {
      // ロール経由の実行は、対象を明示しないと全アカウントが同時に一時停止してしまうので必須にする
      if (!targetUserId) return msg.channel.send('対象アカウントを@メンションで指定して(例: !pause @account)');
      if (targetUserId !== client.user.id) return;
    } else if (targetUserId && targetUserId !== client.user.id) {
      return;
    }

    const state = client.accountState;
    state.lockedDown = !state.lockedDown;
    logger.log('LOCKDOWN', `[${state.id}] ${state.lockedDown ? '有効化' : '解除'}`);
    await msg.channel.send(state.lockedDown ? '🔒 ロックダウン: 自動応答を停止しました' : '🔓 ロックダウン解除: 自動応答を再開しました');
  }
};
