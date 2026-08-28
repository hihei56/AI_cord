const logger = require('../../utils/logger');
const { scheduleReminder } = require('../../reminderScheduler');

// "10m", "2h", "1d", "1h30m" のような時間指定をミリ秒に変換
function parseDuration(str) {
  const re = /(\d+)\s*(s|m|h|d)/gi;
  let match;
  let totalMs = 0;
  let matched = false;
  while ((match = re.exec(str)) !== null) {
    matched = true;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
    totalMs += value * unitMs;
  }
  return matched ? totalMs : null;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = {
  name: 'remind',
  aliases: ['リマインド'],
  description: 'リマインダーの設定/一覧/取消。!remind <時間(10m,2h,1d,1h30m等)> <内容> / !remind list / !remind cancel <id>',
  async execute(msg, args, client) {
    const state = client.accountState;
    const [sub] = args;

    if (sub === 'list') {
      const list = state.reminderStore.list();
      if (list.length === 0) {
        await msg.channel.send('(リマインダーなし)');
        return;
      }
      const lines = list.map((r) => `\`${r.id}\` ${new Date(r.dueAt).toLocaleString('ja-JP')} - ${r.message}`);
      await msg.channel.send(lines.join('\n'));
      return;
    }

    if (sub === 'cancel') {
      const id = args[1];
      state.reminderStore.remove(id);
      await msg.channel.send(id ? `🗑️ \`${id}\` を取り消しました` : '使い方: !remind cancel <id>');
      return;
    }

    const durationMs = parseDuration(args[0] || '');
    const message = args.slice(1).join(' ');

    if (!durationMs) {
      await msg.channel.send('使い方: !remind <時間(例: 10m, 2h, 1d, 1h30m)> <内容>');
      return;
    }
    if (!message) {
      await msg.channel.send('リマインド内容を指定してください');
      return;
    }

    const reminder = {
      id: makeId(),
      channelId: msg.channel.id,
      userId: msg.author.id,
      message,
      dueAt: Date.now() + durationMs
    };

    state.reminderStore.add(reminder);
    scheduleReminder(client, state.reminderStore, reminder);

    logger.log('REMINDER', `[${state.id}] ${reminder.id} を${args[0]}後に設定`);
    await msg.channel.send(`⏰ ${args[0]}後にリマインドします (\`${reminder.id}\`)`);
  }
};
