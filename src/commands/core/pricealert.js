const store = require('../../utils/priceAlertStore');
const { fetchPrices } = require('../../utils/priceApi');
const config = require('../../utils/config');

module.exports = {
  name: 'pricealert',
  aliases: ['price', 'ねだん'],
  description:
    '仮想通貨の価格アラート。!pricealert channel(今のチャンネルを通知先に設定) / add|remove <銘柄> / list / now(即時チェック) / setid <銘柄> <CoinGecko id か チェーン:ペアアドレス>(自動解決に失敗した銘柄を手動指定)',
  async execute(msg, args) {
    const sub = args[0]?.toLowerCase();

    if (sub === 'channel') {
      store.setChannelId(msg.channel.id);
      return msg.channel.send(`✅ このチャンネル(<#${msg.channel.id}>)を価格アラートの通知先に設定しました`);
    }

    if (sub === 'add' && args[1]) {
      const symbol = args[1].toLowerCase();
      const added = store.addSymbol(symbol);
      return msg.channel.send(added ? `✅ ${symbol.toUpperCase()}を監視対象に追加` : `${symbol.toUpperCase()}は既に監視対象`);
    }

    if ((sub === 'remove' || sub === 'rm') && args[1]) {
      const symbol = args[1].toLowerCase();
      const removed = store.removeSymbol(symbol);
      return msg.channel.send(removed ? `🗑️ ${symbol.toUpperCase()}を監視対象から削除` : `${symbol.toUpperCase()}は監視対象に無い`);
    }

    if (sub === 'setid' && args[1] && args[2]) {
      const symbol = args[1].toLowerCase();
      store.setOverride(symbol, args[2]);
      return msg.channel.send(`✅ ${symbol.toUpperCase()}の解決先を手動指定: \`${args[2]}\`(次回チェックから反映)`);
    }

    if (sub === 'list') {
      const channelId = store.getChannelId();
      const symbols = store.getSymbols();
      const overrides = store.getOverrides();
      const lines = symbols.map((s) => (overrides[s] ? `${s.toUpperCase()} (手動指定: ${overrides[s]})` : s.toUpperCase()));
      return msg.channel.send(
        `通知先チャンネル: ${channelId ? `<#${channelId}>` : '(未設定、!pricealert channel で設定して)'}\n` +
          `監視銘柄: ${lines.length ? lines.join(', ') : '(なし)'}\n` +
          `変動しきい値: ±${config.priceAlert?.changeThresholdPercent ?? 5}%`
      );
    }

    if (sub === 'now') {
      const symbols = store.getSymbols();
      if (symbols.length === 0) return msg.channel.send('監視銘柄が未設定です。!pricealert add <銘柄> で追加して');

      await msg.channel.send('📡 取得中...');
      const currency = config.priceAlert?.currency || 'usd';
      const prices = await fetchPrices(symbols, currency, store.getOverrides());

      const lines = symbols.map((s) => {
        const p = prices[s];
        if (!p || p[currency] === undefined) {
          return `${s.toUpperCase()}: 取得失敗(銘柄を自動解決できない可能性。!pricealert setid ${s} <CoinGecko id か チェーン:ペアアドレス> で手動指定して)`;
        }
        const change = p[`${currency}_24h_change`];
        const changeStr = typeof change === 'number' ? ` (24h ${change > 0 ? '+' : ''}${change.toFixed(1)}%)` : '';
        return `${s.toUpperCase()}: ${p[currency].toLocaleString('ja-JP', { maximumFractionDigits: 6 })} ${currency.toUpperCase()}${changeStr}`;
      });
      return msg.channel.send(`💰 現在価格\n${lines.join('\n')}`);
    }

    return msg.channel.send(
      '使い方:\n' +
        '!pricealert channel (今のチャンネルを通知先に設定)\n' +
        '!pricealert add|remove <銘柄>\n' +
        '!pricealert list\n' +
        '!pricealert now (即時チェック)\n' +
        '!pricealert setid <銘柄> <CoinGecko id か チェーン:ペアアドレス> (自動解決失敗時の手動指定)'
    );
  }
};
