const { getAllClients } = require('../../utils/accountRegistry');

module.exports = {
  name: 'channel',
  aliases: ['ch'],
  description:
    '応答チャンネルの追加/削除/一覧。!channel add|remove|list [all] [channelId] (省略時は現在のチャンネル、allで全アカウント一括)',
  async execute(msg, args, client) {
    const [sub, ...rest] = args;
    const all = rest[0]?.toLowerCase() === 'all';
    const idArg = all ? rest[1] : rest[0];
    const targetId = idArg || msg.channel.id;
    const targets = all ? getAllClients() : [client];

    if (sub === 'add') {
      const results = targets.map((c) => ({ id: c.accountState.id, added: c.accountState.channelStore.addChannel(targetId) }));
      if (!all) {
        return msg.channel.send(results[0].added ? `✅ <#${targetId}> を応答チャンネルに追加` : `<#${targetId}> は既に登録済み`);
      }
      const addedCount = results.filter((r) => r.added).length;
      return msg.channel.send(
        `✅ <#${targetId}> を全アカウント(${targets.length}件)の応答チャンネルに追加(新規${addedCount}件、既存${targets.length - addedCount}件)`
      );
    }

    if (sub === 'remove' || sub === 'rm') {
      const results = targets.map((c) => ({ id: c.accountState.id, removed: c.accountState.channelStore.removeChannel(targetId) }));
      if (!all) {
        return msg.channel.send(results[0].removed ? `🗑️ <#${targetId}> を応答チャンネルから削除` : `<#${targetId}> は登録されてない`);
      }
      const removedCount = results.filter((r) => r.removed).length;
      return msg.channel.send(`🗑️ <#${targetId}> を全アカウント(${targets.length}件)から削除(${removedCount}件を削除)`);
    }

    if (!sub || sub === 'list') {
      if (!all) {
        const list = client.accountState.channelStore.listChannels();
        return msg.channel.send(list.length ? `応答チャンネル:\n${list.map((c) => `<#${c}>`).join('\n')}` : '(応答チャンネルなし)');
      }
      const lines = targets.map((c) => {
        const list = c.accountState.channelStore.listChannels();
        return `**[${c.accountState.id}] ${c.user?.username ?? '?'}**\n${list.length ? list.map((ch) => `<#${ch}>`).join('\n') : '(なし)'}`;
      });
      return msg.channel.send(lines.join('\n\n'));
    }

    await msg.channel.send('使い方: !channel add|remove|list [all] [channelId] (省略時は現在のチャンネル、allで全アカウント一括)');
  }
};
