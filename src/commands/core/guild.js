const { getAllClients } = require('../../utils/accountRegistry');
const { saveGuildId } = require('../../utils/guildStore');

module.exports = {
  name: 'guild',
  aliases: ['server'],
  description:
    '動作サーバーの変更/確認。!guild set [all] [serverId] (省略時は今いるサーバー、allで全アカウント一括)、!guild show [all]',
  async execute(msg, args, client) {
    const [sub, ...rest] = args;
    const all = rest[0]?.toLowerCase() === 'all';
    const idArg = all ? rest[1] : rest[0];
    const targets = all ? getAllClients() : [client];

    if (sub === 'set') {
      const guildId = idArg || msg.guild?.id;
      if (!guildId || !/^\d{15,20}$/.test(guildId)) {
        return msg.channel.send('サーバーIDを指定して(例: !guild set 1551952305958424616)。サーバー内で実行すれば省略可');
      }
      for (const c of targets) {
        c.accountState.allowedGuildId = guildId;
        saveGuildId(c.accountState.id, guildId);
      }
      return msg.channel.send(
        `✅ ${all ? `全アカウント(${targets.length}件)` : client.user.username} の動作サーバーを ${guildId} に変更(再起動後も維持)\n` +
          'このサーバーで応答させたいチャンネルは !channel add [all] で登録してね'
      );
    }

    if (!sub || sub === 'show') {
      const lines = targets.map((c) => `[${c.accountState.id}] ${c.user?.username ?? '?'}: ${c.accountState.allowedGuildId ?? '(未設定)'}`);
      return msg.channel.send(`動作サーバー:\n${lines.join('\n')}`);
    }

    await msg.channel.send('使い方: !guild set [all] [serverId] / !guild show [all]');
  }
};
