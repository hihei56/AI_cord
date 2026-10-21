const store = require('../utils/relayStore');
const { parseChannelMention } = require('./mentionUtils');

module.exports = {
  name: 'relay',
  description:
    '特定チャンネルの投稿を他チャンネルへそのまま転送するミラー機能の管理(このコマンドを実行したアカウントに紐づく)。' +
    '!relay source [#channel] / adddest <#channel> / removedest <#channel> / list / on / off',
  async execute(msg, args, client) {
    const state = client.accountState.relay;
    const sub = args[0]?.toLowerCase();

    if (sub === 'source') {
      const channelId = args[1] ? parseChannelMention(args[1]) : msg.channel.id;
      if (!channelId) return msg.channel.send('チャンネルの指定が不正です(#channelかチャンネルIDで指定してください)');
      if (!msg.guild) return msg.channel.send('サーバー内で実行してください');

      store.setSource(client.accountState.id, state, msg.guild.id, channelId);
      return msg.channel.send(`✅ 監視元を <#${channelId}> に設定しました`);
    }

    if (sub === 'adddest') {
      const channelId = args[1] ? parseChannelMention(args[1]) : msg.channel.id;
      if (!channelId) return msg.channel.send('チャンネルの指定が不正です');

      const added = store.addDestination(client.accountState.id, state, channelId);
      if (!added) return msg.channel.send(`既に登録済みです: <#${channelId}>`);
      return msg.channel.send(`✅ 転送先に追加: <#${channelId}>`);
    }

    if (sub === 'removedest' || sub === 'rmdest') {
      const channelId = args[1] ? parseChannelMention(args[1]) : msg.channel.id;
      if (!channelId) return msg.channel.send('チャンネルの指定が不正です');

      const removed = store.removeDestination(client.accountState.id, state, channelId);
      return msg.channel.send(removed ? `🗑️ 転送先から削除: <#${channelId}>` : '登録されていません');
    }

    if (sub === 'on' || sub === 'off') {
      store.setEnabled(client.accountState.id, state, sub === 'on');
      return msg.channel.send(sub === 'on' ? '✅ 転送を有効化しました' : '🛑 転送を無効化しました');
    }

    if (sub === 'list') {
      const lines = [
        `監視元: ${state.sourceChannelId ? `<#${state.sourceChannelId}>` : '(未設定)'}`,
        `転送先: ${state.destinationChannelIds.length ? state.destinationChannelIds.map((id) => `<#${id}>`).join(', ') : '(未設定)'}`,
        `状態: ${state.enabled ? '✅ 有効' : '🛑 無効'}`
      ];
      return msg.channel.send(lines.join('\n'));
    }

    return msg.channel.send(
      '使い方:\n' +
        '!relay source [#channel] (監視元チャンネルを設定。省略時は今のチャンネル)\n' +
        '!relay adddest [#channel] / removedest [#channel] (転送先の追加/削除、複数可。省略時は今のチャンネル)\n' +
        '!relay on / off (有効化/無効化)\n' +
        '!relay list (現在の設定確認)'
    );
  }
};
