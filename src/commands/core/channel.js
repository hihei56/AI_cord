module.exports = {
  name: 'channel',
  aliases: ['ch'],
  description: '応答チャンネルの追加/削除/一覧。!channel add|remove|list [channelId]',
  async execute(msg, args, client) {
    const { channelStore } = client.accountState;
    const [sub, id] = args;
    const targetId = id || msg.channel.id;

    if (sub === 'add') {
      const added = channelStore.addChannel(targetId);
      await msg.channel.send(added ? `✅ <#${targetId}> を応答チャンネルに追加` : `<#${targetId}> は既に登録済み`);
      return;
    }

    if (sub === 'remove' || sub === 'rm') {
      const removed = channelStore.removeChannel(targetId);
      await msg.channel.send(removed ? `🗑️ <#${targetId}> を応答チャンネルから削除` : `<#${targetId}> は登録されてない`);
      return;
    }

    if (!sub || sub === 'list') {
      const list = channelStore.listChannels();
      await msg.channel.send(list.length ? `応答チャンネル:\n${list.map((c) => `<#${c}>`).join('\n')}` : '(応答チャンネルなし)');
      return;
    }

    await msg.channel.send('使い方: !channel add|remove|list [channelId] (省略時は現在のチャンネル)');
  }
};
