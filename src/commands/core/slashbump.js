const store = require('../../utils/slashBumpStore');
const { parseUserMention, parseChannelMention } = require('../mentionUtils');
const bumpHandler = require('../../handlers/slashBumpHandler');

// args[index]がチャンネルの指定(<#id>かID)として解決できるか試す。解決できなければnull
function tryParseChannelArg(arg) {
  return parseChannelMention(arg);
}

module.exports = {
  name: 'slashbump',
  aliases: ['bump'],
  description:
    '他BOTへのスラッシュコマンドを自動送信(disssokuのbump機能相当)。!slashbump add <botId> <command> [#channel] [表示名] / remove <botId> [#channel] / list / now [botId] [#channel]',
  async execute(msg, args) {
    const sub = args[0]?.toLowerCase();

    if (sub === 'add' && args[1] && args[2]) {
      const botId = parseUserMention(args[1]) || args[1];
      const command = args[2];

      let channelId = msg.channel.id;
      let nameArgs = args.slice(4);
      if (args[3]) {
        const parsedChannel = tryParseChannelArg(args[3]);
        if (parsedChannel) {
          channelId = parsedChannel;
        } else {
          // チャンネル指定でなければ表示名の一部として扱う
          nameArgs = [args[3], ...nameArgs];
        }
      }
      const name = nameArgs.join(' ') || botId;

      const target = store.addTarget({ botId, command, channelId, name });
      if (!target) return msg.channel.send('⚠️ 既に同じBOT×チャンネルの組み合わせが登録済みです');

      bumpHandler.startTarget(target);
      return msg.channel.send(`✅ 追加: ${name}(${botId}) の /${command} を <#${channelId}> で自動実行`);
    }

    if ((sub === 'remove' || sub === 'rm') && args[1]) {
      const botId = parseUserMention(args[1]) || args[1];
      const channelId = tryParseChannelArg(args[2]) || msg.channel.id;
      const removed = store.removeTarget(botId, channelId);
      if (!removed) return msg.channel.send('登録されていません(botIdとチャンネルの組み合わせを確認して)');
      bumpHandler.stopTarget(removed);
      return msg.channel.send(`🗑️ 削除: ${removed.name}(${botId}) / <#${channelId}>`);
    }

    if (sub === 'list') {
      const targets = store.getTargets();
      if (targets.length === 0) return msg.channel.send('(登録なし。!slashbump add <botId> <command> で追加して)');
      const lines = targets.map((t) => `**${t.name}**(${t.botId}) /${t.command} → <#${t.channelId}>`);
      return msg.channel.send(`登録済みbump対象:\n${lines.join('\n')}`);
    }

    if (sub === 'now') {
      const botId = args[1] ? parseUserMention(args[1]) || args[1] : null;
      const channelId = tryParseChannelArg(args[2]) || msg.channel.id;
      const target = botId ? store.findTarget(botId, channelId) : null;
      if (botId && !target) return msg.channel.send('登録されていません(botIdとチャンネルの組み合わせを確認して)');

      const targets = target ? [target] : store.getTargets();
      if (targets.length === 0) return msg.channel.send('登録済みの対象がありません');

      for (const t of targets) await bumpHandler.forceBump(t);
      return msg.channel.send(`📡 ${targets.length}件のbumpを即時実行しました(クールダウンは無視)`);
    }

    return msg.channel.send(
      '使い方:\n' +
        '!slashbump add <botId> <command> [#channel] [表示名] (省略時は今のチャンネル)\n' +
        '!slashbump remove <botId> [#channel]\n' +
        '!slashbump list\n' +
        '!slashbump now [botId] [#channel] (省略時は全対象、クールダウン無視で即時実行)'
    );
  }
};
