const store = require('../utils/rssFeedStore');
const { parseChannelMention } = require('./mentionUtils');
const { checkOnce } = require('../handlers/rssTwitterPostHandler');

module.exports = {
  name: 'rssfeed',
  aliases: ['rss'],
  description:
    'RSS(nitter等)からツイートリンクを取得しvxtwitter形式で投稿する機能の管理(このコマンドを実行したアカウントに紐づく)。' +
    '!rssfeed add <URL> / remove <URL> / channel [#channel] / list / on / off / check',
  async execute(msg, args, client) {
    const state = client.accountState.rssFeed;
    const sub = args[0]?.toLowerCase();

    if (sub === 'check' || sub === 'now') {
      try {
        const result = await checkOnce(client, client.accountState);
        if (result.skipped === 'disabled') return msg.channel.send('🛑 無効化されています(`!rssfeed on`で有効化してください)');
        if (result.skipped === 'not-configured') return msg.channel.send('⚠️ ミラーURLか投稿先チャンネルが未設定です(`!rssfeed add`/`channel`)');
        if (result.skipped === 'first-run') return msg.channel.send(`✅ チェック完了(初回のため既存${result.markedSeen}件を既読登録。投稿は次回以降の新着から)`);
        if (result.skipped === 'no-new-items') return msg.channel.send(`✅ チェック完了(取得${result.fetched}件、新着0件)`);
        if (result.error) return msg.channel.send(`❌ ${result.error}`);
        return msg.channel.send(`✅ チェック完了(${result.posted}件投稿)`);
      } catch (err) {
        return msg.channel.send(`❌ 取得に失敗しました: ${err.message}`);
      }
    }

    if (sub === 'add' && args[1]) {
      const url = args[1];
      const added = store.addFeedUrl(client.accountState.id, state, url);
      if (!added) return msg.channel.send(`既に登録済みです: ${url}`);
      return msg.channel.send(`✅ ミラーURLを追加: ${url}(現在${state.feedUrls.length}件)`);
    }

    if ((sub === 'remove' || sub === 'rm') && args[1]) {
      const url = args[1];
      const removed = store.removeFeedUrl(client.accountState.id, state, url);
      return msg.channel.send(removed ? `🗑️ 削除: ${url}` : '登録されていません');
    }

    if (sub === 'channel') {
      const channelId = args[1] ? parseChannelMention(args[1]) : msg.channel.id;
      if (!channelId) return msg.channel.send('チャンネルの指定が不正です');

      store.setPostChannel(client.accountState.id, state, channelId);
      return msg.channel.send(`✅ 投稿先を <#${channelId}> に設定しました`);
    }

    if (sub === 'on' || sub === 'off') {
      store.setEnabled(client.accountState.id, state, sub === 'on');
      return msg.channel.send(sub === 'on' ? '✅ RSS監視を有効化しました' : '🛑 RSS監視を無効化しました');
    }

    if (sub === 'list') {
      const lines = [
        `ミラーURL:\n${state.feedUrls.length ? state.feedUrls.map((u) => `- ${u}`).join('\n') : '(未設定)'}`,
        `投稿先: ${state.postChannelId ? `<#${state.postChannelId}>` : '(未設定)'}`,
        `状態: ${state.enabled ? '✅ 有効' : '🛑 無効'}`
      ];
      return msg.channel.send(lines.join('\n'));
    }

    return msg.channel.send(
      '使い方:\n' +
        '!rssfeed add <URL> (ミラーURLを追加。複数登録すると先頭から順にフォールバック)\n' +
        '!rssfeed remove <URL>\n' +
        '!rssfeed channel [#channel] (投稿先チャンネルを設定。省略時は今のチャンネル)\n' +
        '!rssfeed on / off (有効化/無効化)\n' +
        '!rssfeed list (現在の設定確認)\n' +
        '!rssfeed check (定期実行を待たず今すぐ1回チェックする。動作確認用)'
    );
  }
};
