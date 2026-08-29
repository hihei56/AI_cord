const { parseUserMention, parseChannelMention } = require('../mentionUtils');

module.exports = {
  name: 'set',
  aliases: [],
  description:
    'アカウント別の設定変更。!set channel @account #channel で応答チャンネル追加、!set mode @account markov|finetune で返信生成方式を切り替え',
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

    if (sub === 'mode') {
      const targetUserId = parseUserMention(args[0]);
      if (!targetUserId) return msg.channel.send('対象アカウントを@メンションで指定して(例: !set mode @account finetune)');
      if (targetUserId !== client.user.id) return;

      const mode = args[1]?.toLowerCase();
      if (mode !== 'markov' && mode !== 'finetune') {
        return msg.channel.send('使い方: !set mode @account markov|finetune');
      }
      if (mode === 'finetune' && !client.accountState.finetuneBaseUrl) {
        return msg.channel.send('⚠️ finetuneモードにはFINETUNE_BASE_URL(.env)の設定が必要です。未設定のため切り替えません');
      }

      client.accountState.aiMode = mode;
      return msg.channel.send(`✅ ${client.user.username} の返信生成方式を ${mode} に切り替えました`);
    }

    return msg.channel.send('使い方: !set channel @account #channel / !set mode @account markov|finetune');
  }
};
