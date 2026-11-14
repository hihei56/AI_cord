const { buildReport, sendReport, guildConf, saveStore, reportChannelId, COACH } = require('../../handlers/serverCoachHandler');

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

module.exports = {
  name: 'coach',
  description:
    'サーバー活性化レポート(発言数・定着率・新規の発言率・死にチャンネル等から問題を検出し、具体化と打ち手を提案)。!coach channel(今のチャンネルを週次レポートの投稿先に) / off / now(今すぐ作成、前回比較の記録は更新しない) / status',
  async execute(msg, args) {
    if (!msg.guild) return msg.channel.send('サーバー内で実行してください');
    const sub = (args[0] || 'status').toLowerCase();
    const conf = guildConf(msg.guild.id);

    if (sub === 'channel') {
      conf.channelId = msg.channel.id;
      saveStore();
      return msg.channel.send(`✅ 毎週${WEEKDAYS[COACH.reportWeekday]}曜${COACH.reportHourJST}時以降に、このチャンネルへレポートを投稿します`);
    }
    if (sub === 'off') {
      conf.channelId = null;
      saveStore();
      return msg.channel.send('🛑 週次レポートを停止しました(.envのSERVER_COACH_CHANNEL_IDが設定されていればそちらに投稿され続けます)');
    }
    if (sub === 'now') {
      await msg.channel.send('📊 集計中...');
      return sendReport(msg.channel, await buildReport(msg.guild, { save: false }));
    }
    const channelId = reportChannelId(msg.guild.id);
    return msg.channel.send(
      `投稿先: ${channelId ? `<#${channelId}>` : '(未設定。!coach channel で設定)'} / 毎週${WEEKDAYS[COACH.reportWeekday]}曜${COACH.reportHourJST}時以降\n最後の投稿: ${conf.lastReportDate || '(なし)'}`
    );
  }
};
