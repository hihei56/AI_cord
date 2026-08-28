const logger = require('./utils/logger');

function scheduleReminder(client, store, reminder) {
  const delay = Math.max(0, reminder.dueAt - Date.now());
  setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(reminder.channelId).catch(() => null);
      if (channel) await channel.send(`⏰ <@${reminder.userId}> ${reminder.message}`);
    } catch (err) {
      logger.error('REMINDER', err);
    } finally {
      store.remove(reminder.id);
    }
  }, delay);
}

// bot起動時に一度呼ぶ。永続化済みの未消化リマインダーを、残り時間分だけ再スケジュールする
// (過ぎているものは即発火する)。
function registerReminderScheduler(client) {
  const state = client.accountState;
  for (const reminder of state.reminderStore.list()) {
    scheduleReminder(client, state.reminderStore, reminder);
  }
}

module.exports = { registerReminderScheduler, scheduleReminder };
