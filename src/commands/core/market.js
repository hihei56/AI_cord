const store = require('../../utils/marketReportStore');
const { buildReport } = require('../../handlers/marketReportHandler');
const config = require('../../utils/config');

module.exports = {
  name: 'market',
  aliases: ['kabu', '株'],
  description:
    '米国株(NASDAQ100/S&P500)の市況まとめ。!market channel(今のチャンネルを毎朝の投稿先に設定) / off(毎朝の投稿を停止) / now(今すぐ表示) / status',
  async execute(msg, args) {
    const sub = args[0]?.toLowerCase();

    if (sub === 'channel') {
      store.setChannelId(msg.channel.id);
      return msg.channel.send(
        `✅ このチャンネル(<#${msg.channel.id}>)に毎朝${config.marketReport?.postHourJST ?? 7}時以降、市況まとめを投稿します`
      );
    }

    if (sub === 'off') {
      store.setChannelId(null);
      return msg.channel.send('🛑 毎朝の市況まとめを停止しました');
    }

    if (sub === 'status') {
      const channelId = store.getChannelId();
      return msg.channel.send(
        `投稿先: ${channelId ? `<#${channelId}>` : '(未設定、!market channel で設定して)'}\n` +
          `機能: ${config.marketReport?.enabled ? '有効' : '無効(config/settings.jsonのmarketReport.enabled)'}\n` +
          `最後に投稿した取引日: ${store.getLastReportedTradingDay() || '(なし)'}`
      );
    }

    if (sub === 'now') {
      await msg.channel.send('📡 取得中...');
      const report = await buildReport();
      return msg.channel.send(report ? report.text : '❌ 株価データを取得できませんでした(Yahoo Financeへの接続失敗の可能性)');
    }

    return msg.channel.send(
      '使い方:\n' +
        '!market channel (今のチャンネルを毎朝の投稿先に設定)\n' +
        '!market off (毎朝の投稿を停止)\n' +
        '!market now (今すぐ表示)\n' +
        '!market status\n' +
        '凡例: 🎯押し目(50/120日線) 🎯🎯深い押し目(200日線) 💀200日線割れ / 数字=線の日数と高値からの下落率 / 🔥RSI70以上 🧊RSI30以下 / VIX!=30以上'
    );
  }
};
