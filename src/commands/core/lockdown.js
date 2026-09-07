const logger = require('../../utils/logger');
const { parseUserMention } = require('../mentionUtils');
const { getAllClients } = require('../../utils/accountRegistry');

module.exports = {
  name: 'lockdown',
  aliases: ['ロックダウン', 'pause'],
  description:
    '自動応答・自発投稿を緊急停止/再開する。!pause all で全アカウント一括、複数アカウント運用中にロール経由で個別に実行する時は !pause @account で対象を指定',
  async execute(msg, args, client) {
    if (args[0]?.toLowerCase() === 'all') {
      const allClients = getAllClients();
      const nextLockedDown = !client.accountState.lockedDown;
      for (const c of allClients) {
        c.accountState.lockedDown = nextLockedDown;
      }
      logger.log('LOCKDOWN', `[全アカウント] ${nextLockedDown ? '有効化' : '解除'} (一括, ${allClients.length}件)`);
      await msg.channel.send(
        nextLockedDown
          ? `🔒 全アカウント(${allClients.length}件)をロックダウンしました`
          : `🔓 全アカウント(${allClients.length}件)のロックダウンを解除しました`
      );
      return;
    }

    const isSelf = msg.author.id === client.user.id;
    const targetUserId = parseUserMention(args[0]);

    if (!isSelf) {
      // ロール経由の実行は、対象を明示しないと全アカウントが同時に一時停止してしまうので必須にする
      if (!targetUserId) return msg.channel.send('対象アカウントを@メンションかallで指定して(例: !pause @account / !pause all)');
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
