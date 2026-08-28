const logger = require('../../utils/logger');

module.exports = {
  name: 'lockdown',
  aliases: ['ロックダウン'],
  description: '自動応答・自発投稿を緊急停止/再開する',
  async execute(msg, args, client) {
    const state = client.accountState;
    state.lockedDown = !state.lockedDown;
    logger.log('LOCKDOWN', `[${state.id}] ${state.lockedDown ? '有効化' : '解除'}`);
    await msg.channel.send(state.lockedDown ? '🔒 ロックダウン: 自動応答を停止しました' : '🔓 ロックダウン解除: 自動応答を再開しました');
  }
};
