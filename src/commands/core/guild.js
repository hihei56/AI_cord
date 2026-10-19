const { getAllClients } = require('../../utils/accountRegistry');

module.exports = {
  name: 'guild',
  aliases: ['server'],
  description:
    '動作サーバーの追加/削除/一覧(複数サーバー掛け持ち可)。!guild add|remove|list [all] [serverId] (省略時は今いるサーバー、allで全アカウント一括)',
  async execute(msg, args, client) {
    const [sub, ...rest] = args;
    const all = rest[0]?.toLowerCase() === 'all';
    const idArg = all ? rest[1] : rest[0];
    const targetId = idArg || msg.guild?.id;
    const targets = all ? getAllClients() : [client];
    const who = all ? `全アカウント(${targets.length}件)` : client.user.username;

    if (sub === 'add' || sub === 'set' || sub === 'remove' || sub === 'rm') {
      if (!targetId || !/^\d{15,20}$/.test(targetId)) {
        return msg.channel.send('サーバーIDを指定して(例: !guild add 1551952305958424616)。サーバー内で実行すれば省略可');
      }
    }

    if (sub === 'add' || sub === 'set') {
      const addedCount = targets.filter((c) => c.accountState.guildStore.addGuild(targetId)).length;
      return msg.channel.send(
        `✅ ${who} の動作サーバーに ${targetId} を追加(新規${addedCount}件、既存${targets.length - addedCount}件)\n` +
          'このサーバーで応答させたいチャンネルは !channel add [all] で登録してね'
      );
    }

    if (sub === 'remove' || sub === 'rm') {
      const removedCount = targets.filter((c) => c.accountState.guildStore.removeGuild(targetId)).length;
      return msg.channel.send(`🗑️ ${who} の動作サーバーから ${targetId} を削除(${removedCount}件を削除)`);
    }

    if (!sub || sub === 'list' || sub === 'show') {
      const listTargets = rest[0]?.toLowerCase() === 'all' ? getAllClients() : [client];
      const lines = listTargets.map((c) => {
        const list = c.accountState.guildStore.listGuilds();
        return `[${c.accountState.id}] ${c.user?.username ?? '?'}: ${list.length ? list.join(', ') : '(なし)'}`;
      });
      return msg.channel.send(`動作サーバー:\n${lines.join('\n')}`);
    }

    await msg.channel.send('使い方: !guild add|remove|list [all] [serverId] (省略時は今いるサーバー、allで全アカウント一括)');
  }
};
