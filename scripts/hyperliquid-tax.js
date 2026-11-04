// Hyperliquidの現物取引から、暗号資産の雑所得を総平均法・円建てで計算する(国税庁「暗号資産の計算書(総平均法用)」と同じ並び)。
// 出力は申告書に書く金額の「根拠資料」。税務署に提出が必須の書類ではない。最終確認は自己責任(できれば税理士)で。
//
// 使い方:
//   node scripts/hyperliquid-tax.js 0xYourAddress --year 2026
//   node scripts/hyperliquid-tax.js 0xYourAddress --year 2026 --opening opening.csv --fx-csv ttm.csv
//
// オプション:
//   --year YYYY        対象年(1/1〜12/31 日本時間。既定: 今年)
//   --opening FILE     Hyperliquid以外の分を総平均に加えるCSV(ヘッダ: token,quantity,cost_jpy)
//                      年初残高や他取引所・他ウォレットで年内に買った同じ銘柄をここに書く(行は合算される)
//   --fx-csv FILE      ドル円レートのCSV(date,rate 例: 2026-07-01,144.50)。三菱UFJ銀行のTTM等を推奨。
//                      省略時はYahoo FinanceのUSDJPY終値(TTMではない近似値)
//   --out DIR          出力先(既定: outputs/hyperliquid)
//   --testnet          テストネット
//
// 計算の前提(違うならこのスクリプトの結果は使えない):
//   - 現物のみ。パーペチュアルの約定があれば警告して計算から除外する
//   - USDC等のステーブルコインは1ドルとみなし、ステーブルコイン自体の為替差損益は計算しない
//   - レートは取引日(日本時間)のレート。その日のレートが無い場合は前日以前で最も近い日
//   - 買いの手数料(受取トークン建て)は取得数量から差し引き、売りの手数料(USDC建て)は売却価額から差し引く
try {
  require('dotenv').config();
} catch {}
const fs = require('fs');
const path = require('path');
const hl = require('./hyperliquid-history');

const TZ = 'Asia/Tokyo';
const STABLES = new Set(['USDC', 'USDT0', 'USDT', 'USDH', 'USDE']);

function parseArgs(argv) {
  const opts = {
    address: process.env.HYPERLIQUID_ADDRESS || null,
    year: Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date())),
    opening: null,
    fxCsv: null,
    out: path.join('outputs', 'hyperliquid'),
    testnet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--year') opts.year = Number(argv[++i]);
    else if (a === '--opening') opts.opening = argv[++i];
    else if (a === '--fx-csv') opts.fxCsv = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--testnet') opts.testnet = true;
    else if (a.startsWith('--')) throw new Error(`不明なオプション: ${a}`);
    else opts.address = a;
  }
  return opts;
}

const dayKey = (ms, zone = TZ) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(ms));

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  return lines.map((l) => l.split(',').map((c) => c.trim()));
}

// ---- 為替レート ----

async function loadFxRates(opts, startMs, endMs) {
  const rates = new Map(); // 'YYYY-MM-DD' -> rate
  if (opts.fxCsv) {
    for (const [d, r] of readCsv(opts.fxCsv)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Number(r))) rates.set(d, Number(r));
    }
    return { rates, source: `CSV(${opts.fxCsv})` };
  }
  const base = process.env.YAHOO_CHART_URL || 'https://query1.finance.yahoo.com/v8/finance/chart';
  // 年初の取引に「前日以前のレート」を当てられるよう2週間前から取る
  const p1 = Math.floor((startMs - 14 * 86400000) / 1000);
  const p2 = Math.floor(endMs / 1000);
  const res = await fetch(`${base}/USDJPY=X?period1=${p1}&period2=${p2}&interval=1d`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`ドル円レートの取得に失敗(HTTP ${res.status})。--fx-csv でレートを渡してください`);
  const result = (await res.json()).chart?.result?.[0];
  const ts = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  // FXの日足はロンドン時間0時始まりのバーなので、その日付で扱う
  for (let i = 0; i < ts.length; i++) if (Number.isFinite(closes[i])) rates.set(dayKey(ts[i] * 1000, 'Europe/London'), closes[i]);
  return { rates, source: 'Yahoo Finance USDJPY=X 終値(TTMではない近似値)' };
}

function makeRateLookup(rates) {
  const days = [...rates.keys()].sort();
  return (day) => {
    // day以前で最も近い日(二分探索)
    let lo = 0, hi = days.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] <= day) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (found < 0) throw new Error(`${day} 以前のドル円レートがありません`);
    const d = days[found];
    if ((Date.parse(day) - Date.parse(d)) / 86400000 > 7) throw new Error(`${day} のドル円レートが見つかりません(直近が${d})`);
    return { rate: rates.get(d), rateDate: d };
  };
}

// ---- Hyperliquidのデータ ----

async function loadSpotPairs(url) {
  const meta = await hl.postInfo(url, { type: 'spotMeta' });
  const tokenName = new Map(meta.tokens.map((t) => [t.index, t.name]));
  const pairs = new Map();
  for (const u of meta.universe) {
    pairs.set(u.name, { base: tokenName.get(u.tokens[0]), quote: tokenName.get(u.tokens[1]) });
  }
  return pairs;
}

function loadOpening(file) {
  const out = new Map();
  if (!file) return out;
  const rows = readCsv(file);
  for (const [i, row] of rows.entries()) {
    if (i === 0 && !Number.isFinite(Number(row[1]))) continue; // ヘッダ
    const [token, q, c] = row;
    const qty = Number(q), cost = Number(c);
    if (!token || !Number.isFinite(qty) || !Number.isFinite(cost)) throw new Error(`${file} ${i + 1}行目が不正: ${row.join(',')}`);
    const cur = out.get(token) || { qty: 0, cost: 0 };
    out.set(token, { qty: cur.qty + qty, cost: cur.cost + cost });
  }
  return out;
}

// ---- 計算 ----

function computeTax(fills, pairs, lookupRate, opening) {
  const warnings = [];
  const details = [];
  const book = new Map(); // token -> 集計
  const get = (t) => {
    if (!book.has(t)) {
      const o = opening.get(t) || { qty: 0, cost: 0 };
      book.set(t, { openQty: o.qty, openCost: o.cost, buyQty: 0, buyJpy: 0, sellQty: 0, sellJpy: 0, n: 0 });
    }
    return book.get(t);
  };
  for (const t of opening.keys()) get(t);

  let perpCount = 0;
  const nonUsdcQuotes = new Set();
  const oddFees = new Set();
  for (const f of fills) {
    const pair = pairs.get(f.coin);
    if (!pair) { perpCount++; continue; }
    if (!STABLES.has(pair.quote)) {
      warnings.push(`ステーブルコイン建てでないペア ${f.coin}(${pair.base}/${pair.quote})の約定を除外しました。手計算が必要です`);
      continue;
    }
    if (pair.quote !== 'USDC') nonUsdcQuotes.add(pair.quote);

    const day = dayKey(f.time);
    const { rate, rateDate } = lookupRate(day);
    const sz = Number(f.sz), px = Number(f.px), fee = Number(f.fee) || 0;
    const usd = px * sz;
    const b = get(pair.base);
    b.n++;
    let qtyDelta, jpy;
    if (f.side === 'B') {
      qtyDelta = f.feeToken === pair.base ? sz - fee : sz;
      jpy = usd * rate;
      b.buyQty += qtyDelta;
      b.buyJpy += jpy;
    } else {
      const netUsd = f.feeToken === pair.quote ? usd - fee : usd;
      qtyDelta = -sz;
      jpy = netUsd * rate;
      b.sellQty += sz;
      b.sellJpy += jpy;
    }
    if (f.feeToken && f.feeToken !== pair.base && f.feeToken !== pair.quote && fee !== 0) oddFees.add(f.feeToken);
    details.push({
      datetime: hl.formatTime(f.time, TZ), pair: `${pair.base}/${pair.quote}`, token: pair.base,
      side: f.side === 'B' ? '購入' : '売却', qty: sz, price_usd: px, amount_usd: usd,
      fee, fee_token: f.feeToken, usdjpy: rate, rate_date: rateDate,
      amount_jpy: Math.round(jpy * 100) / 100, qty_delta: qtyDelta, tid: f.tid, hash: f.hash,
    });
  }
  if (perpCount) warnings.push(`パーペチュアル等の約定${perpCount}件は計算に含めていません(現物のみ対応)`);
  if (nonUsdcQuotes.size) warnings.push(`${[...nonUsdcQuotes].join(', ')} 建ての約定を1ドルとみなして計算しました`);
  if (oddFees.size) warnings.push(`${[...oddFees].join(', ')} 建ての手数料は経費に入れていません(所得は多めに出ます)`);

  const summary = [];
  for (const [token, b] of [...book.entries()].sort()) {
    const totalQty = b.openQty + b.buyQty;
    const totalCost = b.openCost + b.buyJpy;
    const avg = totalQty > 0 ? totalCost / totalQty : 0;
    const costOfSold = avg * b.sellQty;
    const endQty = totalQty - b.sellQty;
    if (endQty < -1e-9) {
      warnings.push(`${token}: 売却数量が取得数量を上回っています(${endQty})。他所から移した分を --opening に書いてください`);
    }
    summary.push({
      token,
      opening_qty: b.openQty, opening_jpy: Math.round(b.openCost),
      buy_qty: b.buyQty, buy_jpy: Math.round(b.buyJpy),
      total_qty: totalQty, total_jpy: Math.round(totalCost),
      avg_unit_jpy: Math.round(avg * 100) / 100,
      sell_qty: b.sellQty, sell_jpy: Math.round(b.sellJpy),
      cost_of_sold_jpy: Math.round(costOfSold),
      income_jpy: Math.round(b.sellJpy - costOfSold),
      end_qty: endQty, end_jpy: Math.round(avg * endQty),
      trades: b.n,
    });
  }
  return { summary, details, warnings };
}

// 入出金・送金のうち、トークンの出入り(取得価額や譲渡の扱いを人間が判断すべきもの)を拾う
function reviewLedger(ledger) {
  const notes = [];
  for (const r of ledger) {
    const d = r.delta || {};
    const token = d.token || (d.usdc !== undefined ? 'USDC' : null);
    if (d.type === 'funding' || d.type === 'accountClassTransfer') continue;
    if (token && STABLES.has(token)) continue;
    notes.push(`${hl.formatTime(r.time, TZ)} ${d.type} ${token ?? ''} ${d.amount ?? ''} ${d.destination ? `→ ${d.destination}` : ''}`.trim());
  }
  return notes;
}

const LABELS = {
  token: '銘柄', opening_qty: '年初残高等_数量', opening_jpy: '年初残高等_金額', buy_qty: '年中購入_数量', buy_jpy: '年中購入_金額',
  total_qty: '計_数量', total_jpy: '計_金額', avg_unit_jpy: '総平均単価', sell_qty: '売却_数量', sell_jpy: '売却_金額',
  cost_of_sold_jpy: '売却原価', income_jpy: '所得金額', end_qty: '年末残高_数量', end_jpy: '年末残高_金額', trades: '約定件数',
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.address || !/^0x[0-9a-fA-F]{40}$/.test(opts.address)) {
    throw new Error('アドレス(0x + 40桁16進)を引数か HYPERLIQUID_ADDRESS で指定してください');
  }
  if (!Number.isInteger(opts.year)) throw new Error('--year は西暦4桁');
  const url = process.env.HYPERLIQUID_API_URL || (opts.testnet ? hl.TESTNET_URL : hl.MAINNET_URL);
  const user = opts.address.toLowerCase();
  const startMs = hl.zonedDayStartMs(`${opts.year}-01-01`, TZ);
  const yearEndMs = hl.zonedDayStartMs(`${opts.year + 1}-01-01`, TZ) - 1;
  const endMs = Math.min(yearEndMs, Date.now());
  const provisional = endMs < yearEndMs;

  console.log(`アドレス ${user} / ${opts.year}年分${provisional ? '(年の途中なので暫定値)' : ''}`);
  const opening = loadOpening(opts.opening);
  const pairs = await loadSpotPairs(url);
  const fills = await hl.fetchAllByTime(url, { type: 'userFillsByTime', user, aggregateByTime: false }, startMs, endMs, (f) => `${f.tid}`, '約定');
  if (fills.length >= 10000) throw new Error('約定が10000件に達し、APIの上限で古い約定が欠けている可能性があります。この結果は使えません');
  await hl.sleep(hl.REQUEST_INTERVAL_MS);
  const ledger = await hl.fetchAllByTime(url, { type: 'userNonFundingLedgerUpdates', user }, startMs, endMs, (r) => `${r.time}|${r.hash}|${JSON.stringify(r.delta)}`, '入出金・送金');

  const { rates, source } = await loadFxRates(opts, startMs, endMs);
  const { summary, details, warnings } = computeTax(fills, pairs, makeRateLookup(rates), opening);
  const ledgerNotes = reviewLedger(ledger);

  fs.mkdirSync(opts.out, { recursive: true });
  const prefix = path.join(opts.out, `${user.slice(0, 10)}_tax_${opts.year}`);
  const relabel = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [LABELS[k] || k, v])));
  // Excelで文字化けしないようBOM付きUTF-8
  fs.writeFileSync(`${prefix}_計算書.csv`, '﻿' + hl.toCsv(relabel(summary)));
  fs.writeFileSync(`${prefix}_明細.csv`, '﻿' + hl.toCsv(details));
  fs.writeFileSync(`${prefix}_生データ.json`, JSON.stringify({ address: user, year: opts.year, fxSource: source, fills, ledger }, null, 2));

  const total = summary.reduce((s, r) => s + r.income_jpy, 0);
  const lines = [
    `${opts.year}年分 暗号資産(Hyperliquid現物)の所得 — 総平均法`,
    `レート: ${source}`,
    '',
    ...summary.map((r) => `  ${r.token.padEnd(10)} 売却 ${String(r.sell_jpy).padStart(10)}円 - 原価 ${String(r.cost_of_sold_jpy).padStart(10)}円 = ${String(r.income_jpy).padStart(10)}円`),
    `  合計 所得金額 ${total.toLocaleString('ja-JP')}円`,
  ];
  if (warnings.length) lines.push('', '警告:', ...warnings.map((w) => `  - ${w}`));
  if (ledgerNotes.length) {
    lines.push('', 'ステーブルコイン以外のトークンの出入り(取得価額の追加や、他人への送付=譲渡に当たるかを確認すること):', ...ledgerNotes.map((n) => `  - ${n}`));
  }
  lines.push(
    '',
    '注意:',
    '  - 他の取引所・ウォレットで同じ銘柄を持っている/売買したなら、それも含めて総平均しないと正しくない(--opening)。',
    '  - USDC自体の為替差損益(円で買ったUSDCの取得時と使用時のレート差)は含めていない。',
    '  - 給与所得者で給与以外の所得が年20万円以下なら所得税の確定申告は不要な場合があるが、住民税の申告は別途必要。',
  );
  const report = lines.join('\n');
  fs.writeFileSync(`${prefix}_レポート.txt`, report + '\n');
  console.log('\n' + report);
  console.log(`\n出力: ${prefix}_{計算書.csv, 明細.csv, レポート.txt, 生データ.json}`);
}

module.exports = { computeTax, makeRateLookup, loadOpening };

if (require.main === module) {
  main().catch((err) => {
    console.error(`エラー: ${err.message}`);
    process.exit(1);
  });
}
