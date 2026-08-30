const logger = require('../utils/logger');
const presenceLog = require('../utils/presenceLog');

// !presence watch で登録した特定ユーザーだけ、オンラインステータス
// (online/idle/dnd/offline)の変化を記録する。追跡対象はアカウント間で共有
// (data/tracked-presence-users.json)なので、どのアカウントが先にイベントを
// 受け取っても同じログに記録される。
function registerPresenceTrackerHandler(client) {
  client.on('presenceUpdate', (oldPresence, newPresence) => {
    try {
      const userId = newPresence?.userId;
      if (!userId || !presenceLog.isTracked(userId)) return;

      presenceLog.recordStatus(userId, newPresence.status || 'offline');
    } catch (err) {
      logger.error('PRESENCE-TRACK', err);
    }
  });
}

module.exports = { registerPresenceTrackerHandler };
