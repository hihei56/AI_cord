const store = require('../utils/slashBumpStore');
const config = require('../utils/config');
const { parseUserMention, parseChannelMention } = require('./mentionUtils');
const bumpHandler = require('../handlers/slashBumpHandler');

// args[index]がチャンネルの指定(<#id>かID)として解決できるか試す。解決できなければnull
function tryParseChannelArg(arg) {
  return parseChannelMention(arg);
}

module.exports = {
  name: 'slashbump',
  aliases: ['bump'],
  description:
    '他BOTへのスラッシュコマンドを自動送信(disssokuのbump機能相当)。!slashbump add <botId> <command> [#channel] [表示名] (同じbotId×チャンネルに再度addするとコマンド/表示名を上書き更新) / remove <botId> [#channel] / list / now [botId] [#channel] / notify <botId> <@user|off> [#channel] / mode <botId> <daily|continuous> [#channel]',
  async execute(msg, args) {
    const sub = args[0]?.toLowerCase();

    if (sub === 'add' && args[1] && args[2]) {
      const botId = parseUserMention(args[1]) || args[1];
      // Discordのスラッシュコマンド名自体は先頭に"/"を含まない(sendSlashに渡すと
      // ライブラリ内のバリデーションで弾かれ"Invalid string format"エラーになる)。
      // "/bump"のようにDiscord上の表示のまま入力してしまうのは自然な間違いなので、
      // 先頭の"/"だけ許容して自動で取り除く
      const command = args[2].replace(/^\//, '');

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

      const { target, created } = store.addTarget({ botId, command, channelId, name });
      if (!created) {
        return msg.channel.send(`♻️ 更新: ${name}(${botId}) を <#${channelId}> で /${command} を自動実行するよう変更しました`);
      }

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
      const lines = targets.map((t) => {
        const modeLabel = t.mode === 'daily' ? '1日1回' : '通常(クールダウン追従)';
        return `**${t.name}**(${t.botId}) /${t.command} → <#${t.channelId}> [${modeLabel}]`;
      });
      return msg.channel.send(`登録済みbump対象:\n${lines.join('\n')}`);
    }

    if (sub === 'mode' && args[1] && args[2]) {
      const botId = parseUserMention(args[1]) || args[1];
      const mode = args[2].toLowerCase();
      if (mode !== 'daily' && mode !== 'continuous') {
        return msg.channel.send('modeは`daily`か`continuous`のどちらかを指定してください');
      }
      const channelId = tryParseChannelArg(args[3]) || msg.channel.id;

      const target = store.setMode(botId, channelId, mode);
      if (!target) return msg.channel.send('登録されていません(先に!slashbump addで対象を登録して)');

      // 実行中のスケジュール(continuousのクールダウン追従タイマー/dailyの毎日チェック
      // タイマー)をモードに合わせて切り替える
      bumpHandler.stopTarget(target);
      bumpHandler.startTarget(target);

      if (mode === 'daily') {
        const { windowStartHour = 8, windowEndHour = 23 } = config.slashBumpDaily || {};
        return msg.channel.send(
          `🕗 ${target.name}を1日1回モードに切り替えました(毎日${windowStartHour}時〜${windowEndHour}時の間でランダムな時刻に1回だけ実行)`
        );
      }
      return msg.channel.send(`🔁 ${target.name}を通常モード(クールダウンを見ながら繰り返し実行)に切り替えました`);
    }

    if (sub === 'notify' && args[1] && args[2]) {
      const botId = parseUserMention(args[1]) || args[1];
      const channelId = tryParseChannelArg(args[3]) || msg.channel.id;
      const isOff = args[2].toLowerCase() === 'off';
      const userId = isOff ? null : parseUserMention(args[2]) || args[2];

      const target = store.setMentionUser(botId, channelId, userId);
      if (!target) return msg.channel.send('登録されていません(先に!slashbump addで対象を登録して)');

      return msg.channel.send(
        isOff
          ? `🔕 ${target.name}のbump確認メンションをオフにしました`
          : `🔔 ${target.name}のbump自動実行のたびに<@${userId}>へ「bump確認してください」ベースの一言でメンションするようにしました`
      );
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
        '!slashbump add <botId> <command> [#channel] [表示名] (省略時は今のチャンネル。既に登録済みなら上書き更新)\n' +
        '!slashbump remove <botId> [#channel]\n' +
        '!slashbump list\n' +
        '!slashbump now [botId] [#channel] (省略時は全対象、クールダウン無視で即時実行)\n' +
        '!slashbump notify <botId> <@user> [#channel] (自動bump実行のたびにそのユーザーをメンションして確認を喚起。offで解除)\n' +
        '!slashbump mode <botId> <daily|continuous> [#channel] (dailyにすると1日1回、日中活動時間帯からランダムな時刻に1回だけ実行。既定はcontinuous=クールダウンを見ながら繰り返し実行)'
    );
  }
};
