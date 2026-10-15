const store = require('../../utils/houseWatchStore');
const config = require('../../utils/config');
const { checkOnce } = require('../../handlers/houseWatchHandler');

module.exports = {
  name: 'housewatch',
  aliases: ['oie', 'おうち'],
  description:
    'なんJ実況G(livegalileo)の🏡入りID非表示スレ(!extend:none:...)の検知。!housewatch channel(今のチャンネルを通知先に設定) / off / status / now(即時チェック)',
  async execute(msg, args) {
    const sub = args[0]?.toLowerCase();

    if (sub === 'channel') {
      store.setChannelId(msg.channel.id);
      return msg.channel.send(`✅ このチャンネル(<#${msg.channel.id}>)をお🏡検知の通知先に設定しました`);
    }

    if (sub === 'off') {
      store.setChannelId(null);
      return msg.channel.send('🛑 お🏡検知の通知を停止しました(!housewatch channel で再開)');
    }

    if (sub === 'status') {
      const channelId = store.getChannelId();
      const hw = config.houseWatch || {};
      return msg.channel.send(
        `通知先: ${channelId ? `<#${channelId}>` : '(未設定)'}\n` +
          `監視板: ${hw.boardUrl}\n` +
          `条件: タイトルに「${hw.keyword || '🏡'}」 + >>1のEXTDATでID=${hw.extendIdMode || 'none'}\n` +
          `間隔: 約${Math.round((hw.checkIntervalMs || 120000) / 1000)}秒${hw.enabled ? '' : ' (settings.jsonでenabled=falseのため自動監視は停止中)'}`
      );
    }

    if (sub === 'now') {
      await msg.channel.send('📡 チェック中...');
      const r = await checkOnce(msg.client, { manual: true });
      if (r.error) return msg.channel.send(`⚠️ ${r.error}`);
      return msg.channel.send(`完了: 新規候補${r.candidates}件 / 該当${r.found.length}件`);
    }

    return msg.channel.send(
      '使い方:\n' +
        '!housewatch channel (今のチャンネルを通知先に設定)\n' +
        '!housewatch off (通知停止)\n' +
        '!housewatch status\n' +
        '!housewatch now (即時チェック)'
    );
  }
};
