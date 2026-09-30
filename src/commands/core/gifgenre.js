const gifGenreStore = require('../../utils/gifGenreStore');

module.exports = {
  name: 'gifgenre',
  aliases: ['gif'],
  description:
    'GIF投稿(定期投稿/自発投稿・掛け合いへの混在)で使う検索キーワードを管理。!gifgenre add <キーワード> / remove <キーワード> / list',
  async execute(msg, args, client) {
    const state = client.accountState;
    const sub = args[0]?.toLowerCase();

    if (sub === 'add' && args[1]) {
      const keyword = args.slice(1).join(' ');
      const added = gifGenreStore.addGenre(state.id, state.gifGenres, keyword);
      if (!added) return msg.channel.send(`⚠️ 既に登録済みです: 「${keyword}」`);
      return msg.channel.send(`✅ 追加: 「${keyword}」(現在${state.gifGenres.length}件)`);
    }

    if ((sub === 'remove' || sub === 'rm') && args[1]) {
      const keyword = args.slice(1).join(' ');
      const removed = gifGenreStore.removeGenre(state.id, state.gifGenres, keyword);
      return msg.channel.send(removed ? `🗑️ 削除: 「${keyword}」` : `登録されていません: 「${keyword}」`);
    }

    if (sub === 'list') {
      if (state.gifGenres.length === 0) return msg.channel.send('(未登録。!gifgenre add <キーワード> で追加して)');
      return msg.channel.send(`登録中のキーワード:\n${state.gifGenres.map((g) => `- ${g}`).join('\n')}`);
    }

    return msg.channel.send(
      '使い方:\n' +
        '!gifgenre add <キーワード> (スペース区切りでそのまま検索語になる。例: !gifgenre add idolmaster smoky thrill)\n' +
        '!gifgenre remove <キーワード>\n' +
        '!gifgenre list'
    );
  }
};
