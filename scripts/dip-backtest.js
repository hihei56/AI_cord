// 押し目判定(marketData.detectDips)の過去成績を確かめるバックテスト。
// 判定が出た日に買っていたら、その後20/60/120営業日でどうなったかを
// 種類・スコア別に集計し、「毎日買っていた場合(全日平均)」と比べる。
//
// 使い方:
//   node scripts/dip-backtest.js ^NDX          # Yahoo Financeから全期間を取得
//   node scripts/dip-backtest.js BTC-USD --touch 3 --ddmin 15 --ddmax 40
//   node scripts/dip-backtest.js --csv data.csv # 日付,終値 のCSV(ヘッダ行は数値でなければ無視)
// ^NDX/^GSPC等の米国株はVIXも取得してスコアの加点に使う(--novixで無効)
const fs = require('fs');
const { fetchDailyCloses, detectDips } = require('../src/utils/marketData');

function parseArgs(argv) {
  const opts = { symbol: null, csv: null, touch: 1, ddmin: 5, ddmax: 15, rsimax: 40, vixmin: 25, vix: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') opts.csv = argv[++i];
    else if (a === '--touch') opts.touch = Number(argv[++i]);
    else if (a === '--ddmin') opts.ddmin = Number(argv[++i]);
    else if (a === '--ddmax') opts.ddmax = Number(argv[++i]);
    else if (a === '--rsimax') opts.rsimax = Number(argv[++i]);
    else if (a === '--vixmin') opts.vixmin = Number(argv[++i]);
    else if (a === '--novix') opts.vix = false;
    else opts.symbol = a;
  }
  return opts;
}

function dayKey(timeMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(timeMs));
}

function loadCsv(file) {
  return fs
    .readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.split(','))
    .filter((cols) => cols.length >= 2 && Number.isFinite(Number(cols[1])))
    .map((cols) => ({ day: cols[0].trim(), close: Number(cols[1]) }));
}

function summarize(returns) {
  if (returns.length === 0) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  return {
    n: returns.length,
    avg,
    median: sorted[Math.floor(sorted.length / 2)],
    win: (returns.filter((r) => r > 0).length / returns.length) * 100,
    worst: sorted[0]
  };
}

function pct(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let bars;
  if (opts.csv) {
    bars = loadCsv(opts.csv);
  } else if (opts.symbol) {
    const data = await fetchDailyCloses(opts.symbol, 'max');
    if (!data) throw new Error(`${opts.symbol}の取得に失敗(Yahoo Financeに接続できない場合は--csvで渡して)`);
    bars = data.bars.map((b) => ({ day: dayKey(b.time), close: b.close }));
  } else {
    console.log('使い方: node scripts/dip-backtest.js <Yahooのシンボル> | --csv <ファイル> [--touch 1] [--ddmin 5] [--ddmax 15] [--rsimax 40]');
    return;
  }

  let vixByDay = null;
  if (opts.vix && !opts.csv && opts.symbol.startsWith('^')) {
    const vixData = await fetchDailyCloses('^VIX', 'max');
    if (vixData) vixByDay = new Map(vixData.bars.map((b) => [dayKey(b.time), b.close]));
  }

  const closes = bars.map((b) => b.close);
  const horizons = [20, 60, 120];
  const groups = new Map();
  const add = (key, i) => {
    if (!groups.has(key)) groups.set(key, { signals: [], rets: horizons.map(() => []), dd60: [] });
    const g = groups.get(key);
    g.signals.push(bars[i].day);
    horizons.forEach((h, hi) => {
      if (i + h < closes.length) g.rets[hi].push((closes[i + h] / closes[i] - 1) * 100);
    });
    // その後60営業日の間に、買値から最大どこまで下がったか(含み損の深さ)
    if (i + 60 < closes.length) {
      const minAfter = Math.min(...closes.slice(i + 1, i + 61));
      g.dd60.push((minAfter / closes[i] - 1) * 100);
    }
  };

  for (let i = 260; i < closes.length; i++) {
    add('全日(毎日買った場合)', i);
    const vix = vixByDay?.get(bars[i].day);
    const dips = detectDips(closes.slice(0, i + 1), [50, 120, 200], opts.touch, {
      drawdownMin: opts.ddmin,
      drawdownMax: opts.ddmax,
      rsiMax: opts.rsimax,
      fearBonus: Number.isFinite(vix) && vix >= opts.vixmin
    });
    for (const d of dips) {
      if (d.kind === 'trend_break') add('💀200日線割れ', i);
      else {
        add(d.kind === 'deep_dip' ? '🎯🎯深い押し目' : '🎯押し目', i);
        add(`★${d.score}`, i);
      }
    }
  }

  console.log(`対象: ${opts.symbol || opts.csv}  期間: ${bars[0].day} 〜 ${bars[bars.length - 1].day}  (${bars.length}日)`);
  console.log(`条件: touch ±${opts.touch}% / 下落率${opts.ddmin}〜${opts.ddmax}% / RSI≤${opts.rsimax}${vixByDay ? ` / VIX≥${opts.vixmin}` : ''}\n`);
  const order = ['全日(毎日買った場合)', '🎯押し目', '🎯🎯深い押し目', '★1', '★2', '★3', '★4', '💀200日線割れ'];
  for (const key of order) {
    const g = groups.get(key);
    if (!g) continue;
    const parts = horizons.map((h, hi) => {
      const s = summarize(g.rets[hi]);
      return s ? `${h}日後 平均${pct(s.avg)} 中央値${pct(s.median)} 勝率${s.win.toFixed(0)}%` : `${h}日後 -`;
    });
    const dd = summarize(g.dd60);
    console.log(`${key}  (${g.signals.length}回)`);
    console.log(`  ${parts.join(' | ')}`);
    if (dd) console.log(`  60日以内の最大含み損: 平均${pct(dd.avg)} 最悪${pct(dd.worst)}`);
    if (key !== order[0] && g.signals.length <= 30) console.log(`  発生日: ${g.signals.join(', ')}`);
  }
  console.log('\n※回数が少ない(目安30回未満)グループの平均は偶然に左右されやすい');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
