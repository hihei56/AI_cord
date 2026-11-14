const config = require('./config');
const logger = require('./logger');

// Discord側のレート制限(429)を短時間に何度も踏んだアカウントを自動で一時停止する。
// セルフボットにとって一番の実害はアカウント停止で、レート制限の連発はDiscordから
// 「機械的に叩いている」と見られる材料そのもの。人が!pauseするのを待たず、
// しきい値を超えたら自動でlockedDownにし、一定時間後に自動で解除する。
// 手動の!pause(lockedDown)は自動解除しない(autoPausedで区別する)
const GUARD = {
  windowMs: 10 * 60000,
  maxHits: 5,
  pauseMs: 30 * 60000,
  ...(config.discordGuard || {})
};

function registerDiscordGuard(client) {
  const state = client.accountState;
  const hits = [];

  client.on('rateLimit', (info) => {
    const now = Date.now();
    hits.push(now);
    while (hits.length && now - hits[0] > GUARD.windowMs) hits.shift();
    logger.log('GUARD', `[${state.id}] Discordのレート制限 ${info?.method || ''} ${info?.route || info?.path || ''} (直近${Math.round(GUARD.windowMs / 60000)}分で${hits.length}回)`);

    if (hits.length < GUARD.maxHits || state.lockedDown) return;
    state.lockedDown = true;
    state.autoPaused = true;
    hits.length = 0;
    logger.error('GUARD', `[${state.id}] レート制限が${GUARD.maxHits}回を超えたため${Math.round(GUARD.pauseMs / 60000)}分間自動停止`);
    setTimeout(() => {
      if (!state.autoPaused) return; // その間に手動で操作された場合は触らない
      state.lockedDown = false;
      state.autoPaused = false;
      logger.log('GUARD', `[${state.id}] 自動停止を解除`);
    }, GUARD.pauseMs).unref();
  });
}

module.exports = { registerDiscordGuard };
