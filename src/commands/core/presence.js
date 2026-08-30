const { parseUserMention } = require('../mentionUtils');
const presenceLog = require('../../utils/presenceLog');

const STATUS_LABEL = {
  online: '🟢オンライン',
  idle: '🌙退席中',
  dnd: '⛔取り込み中',
  offline: '⚫オフライン'
};

function formatEntry(entry) {
  const label = STATUS_LABEL[entry.status] || entry.status;
  return `${new Date(entry.timestamp).toLocaleString('ja-JP')} - ${label}`;
}

module.exports = {
  name: 'presence',
  aliases: ['status'],
  description:
    '特定ユーザーのオンラインステータス(直近5日分)を記録・確認。' +
    '!presence watch @user / !presence unwatch @user / !presence log @user / !presence list',
  async execute(msg, args, client) {
    const sub = args.shift();

    if (sub === 'watch') {
      const userId = parseUserMention(args[0]);
      if (!userId) return msg.channel.send('対象ユーザーを@メンションで指定して(例: !presence watch @someone)');

      const added = presenceLog.addTracked(userId);
      return msg.channel.send(added ? `👀 <@${userId}> のステータス記録を開始しました` : `<@${userId}> は既に記録対象です`);
    }

    if (sub === 'unwatch') {
      const userId = parseUserMention(args[0]);
      if (!userId) return msg.channel.send('対象ユーザーを@メンションで指定して(例: !presence unwatch @someone)');

      const removed = presenceLog.removeTracked(userId);
      return msg.channel.send(removed ? `🛑 <@${userId}> のステータス記録を停止しました` : `<@${userId}> は記録対象ではありません`);
    }

    if (sub === 'list') {
      const tracked = presenceLog.loadTracked();
      if (tracked.length === 0) return msg.channel.send('(記録対象なし)');
      return msg.channel.send(tracked.map((id) => `<@${id}>`).join('\n'));
    }

    if (sub === 'log') {
      const userId = parseUserMention(args[0]);
      if (!userId) return msg.channel.send('対象ユーザーを@メンションで指定して(例: !presence log @someone)');

      const entries = presenceLog.getLog(userId);
      if (entries.length === 0) {
        return msg.channel.send(
          presenceLog.isTracked(userId)
            ? `<@${userId}> はまだ記録がありません(直近5日以内に状態変化なし)`
            : `<@${userId}> は記録対象になっていません。先に !presence watch @${msg.author.username} で登録して`
        );
      }

      // Discordの1メッセージ上限に収まるよう、直近分を優先して詰めるだけ詰める
      const lines = entries.slice(-30).map(formatEntry);
      return msg.channel.send(`<@${userId}> の直近ステータス変化:\n${lines.join('\n')}`);
    }

    return msg.channel.send('使い方: !presence watch @user / !presence unwatch @user / !presence log @user / !presence list');
  }
};
