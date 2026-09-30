const config = require('../utils/config');
const logger = require('../utils/logger');
const store = require('../utils/priceAlertStore');
const { fetchPrices, fetchDailyCloses } = require('../utils/priceApi');
const { detectDips, formatDip } = require('../utils/marketData');
const { scheduleWithJitter } = require('../utils/scheduler');
const { hourOfDayJST, todayJST } = require('../utils/datetime');
const { sendEach } = require('../utils/sendEach');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 監視銘柄それぞれの日足から押し目を判定して行のリストを返す。
// CoinGeckoの無料APIのレート制限に当たらないよう銘柄ごとに間隔を空ける
async function findCryptoDips() {
  const { maPeriods = [50, 120, 200], touchPercent = 3 } = config.priceAlert?.dip || {};
  const lines = [];
  let fetched = 0;
  for (const symbol of store.getSymbols()) {
    const closes = await fetchDailyCloses(symbol, store.getOverrides());
    if (closes) {
      fetched++;
      lines.push(...detectDips(closes, maPeriods, touchPercent).map((d) => formatDip(symbol.toUpperCase(), d)));
    }
    await sleep(3000);
  }
  return { lines, fetched };
}

// 仮想通貨の日足はUTC 0時(日本時間9時)で切り替わるので、checkHourJST以降に1日1回だけ判定する
async function checkDipsOnce(client) {
  const { checkHourJST = 9 } = config.priceAlert?.dip || {};
  const channel = client.channels?.cache.get(store.getChannelId());
  if (!channel) return;
  const today = todayJST();
  if (hourOfDayJST() < checkHourJST || store.getLastDipCheckDate() === today) return;

  const { lines, fetched } = await findCryptoDips();
  // 1銘柄も取れなかった(API障害等)ならチェック済みにせず次回再試行する
  if (fetched === 0) return;
  store.setLastDipCheckDate(today);
  if (lines.length === 0) return;

  try {
    await sendEach(channel, lines);
    logger.log('PRICE', lines.join(' / '));
  } catch (err) {
    logger.error('PRICE', err);
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

  if (config.priceAlert.dip?.enabled) {
    setInterval(() => checkDipsOnce(client).catch((err) => logger.error('PRICE', err)), 600000);
  }
}

module.exports = { registerPriceAlertHandler, checkOnce, findCryptoDips };
