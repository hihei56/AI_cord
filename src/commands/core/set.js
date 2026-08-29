const { parseUserMention, parseChannelMention } = require('../mentionUtils');

module.exports = {
  name: 'set',
  aliases: [],
  description: 'アカウント別の設定変更。!set channel @account #channel で指定アカウントの応答チャンネルを追加',
  async execute(msg, args, client) {
    const sub = args.shift();

    if (sub === 'channel') {
      const targetUserId = parseUserMention(args[0]);
      if (!targetUserId) return msg.channel.send('対象アカウントを@メンションで指定して(例: !set channel @account #general)');
      if (targetUserId !== client.user.id) return;

      const targetChannelId = parseChannelMention(args[1]);
      if (!targetChannelId) return msg.channel.send('チャンネルを指定して(例: !set channel @account #general)');

      const added = client.accountState.channelStore.addChannel(targetChannelId);
      return msg.channel.send(
        added ? `✅ <#${targetChannelId}> を ${client.user.username} の応答チャンネルに追加` : `<#${targetChannelId}> は既に登録済み`
      );
    }

    return msg.channel.send('使い方: !set channel @account #channel');
  }
};
