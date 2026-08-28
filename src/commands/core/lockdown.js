const { isLockedDown, setLockdown } = require('../../utils/lockdown');
const logger = require('../../utils/logger');

module.exports = {
  name: 'lockdown',
  aliases: ['ロックダウン'],
  description: '自動応答・自発投稿を緊急停止/再開する',
  async execute(msg) {
    const next = !isLockedDown();
    setLockdown(next);
    logger.log('LOCKDOWN', next ? '有効化' : '解除');
    await msg.channel.send(next ? '🔒 ロックダウン: 自動応答を停止しました' : '🔓 ロックダウン解除: 自動応答を再開しました');
  }
};
