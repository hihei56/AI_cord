const config = require('../../utils/config');
const { setNickname, removeNickname } = require('../../utils/nicknames');
const { learnNicknames } = require('../../utils/nicknameLearner');
const { parseUserMention: parseUserId } = require('../mentionUtils');

module.exports = {
  name: 'nickname',
  aliases: ['nick', '呼び名'],
  description:
    '呼び名の管理。!nickname learn @user [件数] で会話から候補を探索、!nickname set @user 名前 で登録、!nickname remove @user / !nickname list',
  async execute(msg, args) {
    const sub = (args.shift() || '').toLowerCase();
    const userId = parseUserId(args[0]);
    if (userId) args.shift();

    if (sub === 'learn') {
      if (!userId) return msg.channel.send('対象ユーザーを@メンションかIDで指定して(例: !nickname learn @user)');
      const fetchLimit = Number(args[0]) || 300;
      await msg.channel.send(`🔍 直近${fetchLimit}件からの呼びかけを探索中...`);
      const candidates = await learnNicknames(msg.channel, userId, fetchLimit);
      if (candidates.length === 0) return msg.channel.send('呼び名の候補は見つからなかった');
      const top = candidates.slice(0, 5).map(([name, count]) => `${name}(${count}回)`).join(' / ');
      return msg.channel.send(`候補: ${top}\n登録するなら \`!nickname set ${userId} 名前\``);
    }

    if (sub === 'set') {
      if (!userId) return msg.channel.send('対象ユーザーを@メンションかIDで指定して');
      const name = args.join(' ').trim();
      if (!name) return msg.channel.send('呼び名を指定して(例: !nickname set @user しゅーちゃん)');
      setNickname(userId, name);
      return msg.channel.send(`✅ 登録した: ${userId} → ${name}`);
    }

    if (sub === 'remove') {
      if (!userId) return msg.channel.send('対象ユーザーを@メンションかIDで指定して');
      removeNickname(userId);
      return msg.channel.send(`🗑️ 削除した: ${userId}`);
    }

    if (sub === 'list') {
      const entries = Object.entries(config.nicknames);
      if (entries.length === 0) return msg.channel.send('登録済みの呼び名は無い');
      return msg.channel.send(entries.map(([id, name]) => `${id}: ${name}`).join('\n'));
    }

    return msg.channel.send('使い方: !nickname learn|set|remove|list [@user] [名前]');
  }
};
