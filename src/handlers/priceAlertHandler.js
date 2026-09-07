const config = require('../utils/config');
const logger = require('../utils/logger');
const store = require('../utils/priceAlertStore');
const { fetchPrices } = require('../utils/priceApi');
const { scheduleWithJitter } = require('../utils/scheduler');

function formatPrice(v) {
  if (!Number.isFinite(v)) return '?';
  return v >= 1 ? v.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) : v.toPrecision(4);
}

// 監視銘柄の現在価格を取得し、前回アラート時の基準価格から
// changeThresholdPercent以上動いていたら通知チャンネルに投稿する。
// 初回(基準価格が無い銘柄)は通知せず基準価格をセットするだけ
async function checkOnce(client) {
  const channelId = store.getChannelId();
  const symbols = store.getSymbols();
  if (!channelId || symbols.length === 0) return;

  const channel = client.channels?.cache.get(channelId);
  if (!channel) return;

  const { changeThresholdPercent = 5, currency = 'usd' } = config.priceAlert || {};
  const prices = await fetchPrices(symbols, currency, store.getOverrides());

  const alerts = [];
  for (const symbol of symbols) {
    const p = prices[symbol];
    if (!p || p[currency] === undefined) continue;
    const price = p[currency];
    const ref = store.getRefPrice(symbol);

    if (ref === undefined) {
      store.setRefPrice(symbol, price);
      continue;
    }

    const changePercent = ((price - ref) / ref) * 100;
    if (Math.abs(changePercent) >= changeThresholdPercent) {
      const dir = changePercent > 0 ? '📈' : '📉';
      alerts.push(
        `${dir} **${symbol.toUpperCase()}** ${formatPrice(ref)} → ${formatPrice(price)} (${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}%)`
      );
      store.setRefPrice(symbol, price);
    }
  }

  if (alerts.length > 0) {
    try {
      await channel.send(`💰 価格アラート\n${alerts.join('\n')}`);
      logger.log('PRICE', alerts.join(' / '));
    } catch (err) {
      logger.error('PRICE', err);
    }
  }
}

// 価格アラートはアカウント(persona)に依存しない全体機能なので、複数アカウント運用時も
// 最初のクライアント(clients[0])だけが通知先チャンネルへの投稿を担当する
function registerPriceAlertHandler(clients) {
  if (!config.priceAlert?.enabled) return;
  const client = clients[0];
  if (!client) return;

  const { checkIntervalMs = 900000, checkIntervalJitter = 0.3 } = config.priceAlert;
  scheduleWithJitter(checkIntervalMs, checkIntervalJitter, () => checkOnce(client));
}

module.exports = { registerPriceAlertHandler, checkOnce };
