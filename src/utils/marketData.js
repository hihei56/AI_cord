const logger = require('./logger');

// Yahoo Financeのchart API(非公式・APIキー不要)。公式サポートは無く予告なく
// 仕様変更・遮断されうるため、失敗時はnullを返して呼び出し側で「取得失敗」扱いにする。
// User-Agent無しだと429/403を返されることがあるのでブラウザ相当のUAを付ける
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 200日線+20日前との比較(傾き判定)に最低220本必要なので、休場日込みでも足りるよう2年分取る
async function fetchDailyCloses(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      logger.error('MARKET', `Yahoo chart HTTP ${res.status} (${symbol})`);
      return null;
    }
    const data = await res.json();
    const result = data.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const rawCloses = result?.indicators?.quote?.[0]?.close || [];

    // 休場・データ欠損日はcloseがnullで返るので、日付とセットで除外する
    const bars = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (Number.isFinite(rawCloses[i])) bars.push({ time: timestamps[i] * 1000, close: rawCloses[i] });
    }
    if (bars.length === 0) {
      logger.error('MARKET', `Yahoo chart: 終値データが空 (${symbol})`);
      return null;
    }

    // 米国の取引時間中に取得すると最終バーは確定前の途中値になる
    const regularEnd = result.meta?.currentTradingPeriod?.regular?.end;
    const provisional = Number.isFinite(regularEnd) && Date.now() < regularEnd * 1000;
    return { bars, provisional };
  } catch (err) {
    logger.error('MARKET', `Yahoo chart失敗 (${symbol}): ${err.message}`);
    return null;
  }
}

// S&P500の実績PER。無料で取れる公式APIが無いため、multpl.comのページから
// 「Current S&P 500 PE Ratio」の数値をスクレイピングする(ページ構成が変わると
// 取れなくなるので、その時はnullを返して表示だけ省く)。
// ナスダック100のPERは無料で安定して取れる取得元が見つからないため扱わない
async function fetchSp500Per() {
  try {
    const res = await fetch('https://www.multpl.com/s-p-500-pe-ratio', {
      headers: { 'User-Agent': YAHOO_UA },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      logger.error('MARKET', `multpl HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();
    const match = html.match(/Current S&(?:amp;)?P 500 PE Ratio[\s\S]{0,300}?(\d{1,3}\.\d{1,2})/i);
    return match ? Number(match[1]) : null;
  } catch (err) {
    logger.error('MARKET', `multpl失敗: ${err.message}`);
    return null;
  }
}

// Yahoo FinanceのヘッドラインRSS。見出しとリンクだけを使う(本文は転載しない)
async function fetchMarketHeadlines(symbols, count = 8) {
  const s = symbols.map(encodeURIComponent).join(',');
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${s}&region=US&lang=en-US`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      logger.error('MARKET', `Yahoo RSS HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const strip = (v) => (v || '').replace('<![CDATA[', '').replace(']]>', '').trim();
    return xml
      .split('<item>')
      .slice(1)
      .map((item) => ({
        title: strip(item.match(/<title>([\s\S]*?)<\/title>/)?.[1]),
        link: strip(item.match(/<link>([\s\S]*?)<\/link>/)?.[1])
      }))
      .filter((h) => h.title)
      .slice(0, count);
  } catch (err) {
    logger.error('MARKET', `Yahoo RSS失敗: ${err.message}`);
    return [];
  }
}

// closes[endIndex]を末尾とするn日単純移動平均。データ不足ならnull
function sma(closes, n, endIndex = closes.length - 1) {
  if (endIndex + 1 < n) return null;
  let sum = 0;
  for (let i = endIndex - n + 1; i <= endIndex; i++) sum += closes[i];
  return sum / n;
}

// ワイルダー方式のRSI(一般的なチャートツールと同じ計算)。最初のperiod本の
// 単純平均を起点に、以降は (前回平均*(period-1)+今回)/period で平滑化する
function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// 各移動平均線について「今日の終値との乖離」と「前日→今日で起きたイベント」を返す。
// イベントは状態を保存せず前日と今日の比較だけで判定する(再起動しても二重通知しない)
// - cross_up/cross_down: 前日と今日で終値がMAの上下どちら側にあるかが入れ替わった
// - approach_from_above/below: 今日MAとの乖離が±touchPercent以内に入った(前日は外だった)
function analyzeMovingAverages(closes, periods, touchPercent) {
  const last = closes.length - 1;
  return periods.map((period) => {
    const ma = sma(closes, period, last);
    const prevMa = sma(closes, period, last - 1);
    if (ma === null || prevMa === null) return { period, ma: null };

    const close = closes[last];
    const prevClose = closes[last - 1];
    const diffPercent = ((close - ma) / ma) * 100;
    const prevDiffPercent = ((prevClose - prevMa) / prevMa) * 100;

    let event = null;
    if (prevDiffPercent >= 0 && diffPercent < 0) event = 'cross_down';
    else if (prevDiffPercent < 0 && diffPercent >= 0) event = 'cross_up';
    else if (Math.abs(diffPercent) <= touchPercent && Math.abs(prevDiffPercent) > touchPercent) {
      event = diffPercent >= 0 ? 'approach_from_above' : 'approach_from_below';
    }

    // 傾きは20営業日前のMAとの比較。下向きのMAへのタッチは支持線として弱い
    const maBefore = sma(closes, period, last - 20);
    const slope = maBefore === null ? null : ma >= maBefore ? 'up' : 'down';

    return { period, ma, diffPercent, event, slope };
  });
}

// 「押し目」の判定。上昇トレンド中(200日線が上向き・終値が200日線より上)に、
// 上から下がってきて短中期の移動平均線(50/120日)に±touchPercent以内まで近づいた、
// または割り込んだ日を押し目とみなす。200日線への上からの接近は「深い押し目」、
// 200日線割れはトレンド転換の可能性がある別物として区別して返す
// (200日線を割った後も下げ続けた2000年・2008年・2022年のような局面を押し目と
// 呼ばないため)。下降トレンド中の移動平均線タッチは押し目ではないので何も返さない
// 戻り値: 0件か1件の配列 [{ kind: 'dip'|'deep_dip'|'trend_break', period, drawdownPercent }]
function detectDips(closes, periods, touchPercent, highLookback = 250) {
  const mas = analyzeMovingAverages(closes, periods, touchPercent);
  const longest = mas.reduce((a, m) => (m.ma !== null && (!a || m.period > a.period) ? m : a), null);
  if (!longest || longest.slope !== 'up') return [];

  const close = closes[closes.length - 1];
  const recentHigh = Math.max(...closes.slice(-highLookback));
  const drawdownPercent = ((close - recentHigh) / recentHigh) * 100;

  const results = [];
  for (const m of mas) {
    if (m.ma === null) continue;
    const fromAbove = m.event === 'approach_from_above' || m.event === 'cross_down';
    if (!fromAbove) continue;
    if (m.period === longest.period) {
      results.push({ kind: m.event === 'cross_down' ? 'trend_break' : 'deep_dip', period: m.period, drawdownPercent });
    } else if (close > longest.ma) {
      results.push({ kind: 'dip', period: m.period, drawdownPercent });
    }
  }
  // 1日で複数の線をまとめて割った時に行が並ばないよう、一番深い線の1件だけ返す
  return results.slice(-1);
}

// 本人にだけ分かれば良い短い記号表記(凡例は!market helpに載せている)。
// 🎯=押し目(50/120日線) 🎯🎯=深い押し目(200日線) 💀=200日線割れ、数字は線の期間と高値からの下落率
function formatDip(label, dip) {
  const dd = dip.drawdownPercent.toFixed(1);
  if (dip.kind === 'trend_break') return `💀${label} ${dip.period} ${dd}`;
  if (dip.kind === 'deep_dip') return `🎯🎯${label} ${dip.period} ${dd}`;
  return `🎯${label} ${dip.period} ${dd}`;
}

module.exports = { formatDip, detectDips, fetchDailyCloses, fetchSp500Per, fetchMarketHeadlines, sma, rsi, analyzeMovingAverages };
