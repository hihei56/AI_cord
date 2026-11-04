// Hyperliquidの取引記録(約定・ファンディング・入出金等)を公開Info APIから取得してCSV/JSONに保存する。
// 秘密鍵は不要(読み取り専用)。アドレスはメインアカウント/サブアカウントのもの。APIウォレットのアドレスではない。
//
// 使い方:
//   node scripts/hyperliquid-history.js 0xYourAddress
//   node scripts/hyperliquid-history.js 0xYourAddress --from 2025-01-01 --to 2025-12-31
//   node scripts/hyperliquid-history.js --types fills,funding --format json --out outputs/hl
//   (アドレス省略時は環境変数 HYPERLIQUID_ADDRESS を使う)
//
// オプション:
//   --from YYYY-MM-DD   取得開始日(--tzの日付として解釈。既定: 2023-01-01)
//   --to   YYYY-MM-DD   取得終了日(その日の終わりまで含む。既定: 現在)
//   --types a,b,c       fills(約定) / funding(ファンディング) / ledger(入出金・送金等) / orders(注文履歴) 既定: fills,funding,ledger
//   --format csv|json   出力形式(既定: csv)
//   --out DIR           出力先(既定: outputs/hyperliquid)
//   --tz ZONE           日時表示のタイムゾーン(既定: Asia/Tokyo)
//   --testnet           テストネットを使う
//
// 制約(APIの仕様):
//   - 約定は直近10000件までしかAPIで遡れない。それより古い分は公式UIのエクスポート等で補うこと。
//   - orders(historicalOrders)は直近2000件のみで、期間指定は効かない(取得後に期間で絞り込む)。
try {
  require('dotenv').config(); // .envがあれば読む(未インストールでも動くように任意扱い)
} catch {}
const fs = require('fs');
const path = require('path');

const MAINNET_URL = 'https://api.hyperliquid.xyz/info';
const TESTNET_URL = 'https://api.hyperliquid-testnet.xyz/info';
const REQUEST_INTERVAL_MS = 400; // レート制限(重み1200/分)に対する余裕
const MAX_RETRIES = 5;

function parseArgs(argv) {
  const opts = {
    address: process.env.HYPERLIQUID_ADDRESS || null,
    from: '2023-01-01',
    to: null,
    types: ['fills', 'funding', 'ledger'],
    format: 'csv',
    out: path.join('outputs', 'hyperliquid'),
    tz: 'Asia/Tokyo',
    testnet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') opts.from = argv[++i];
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--types') opts.types = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--format') opts.format = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--tz') opts.tz = argv[++i];
    else if (a === '--testnet') opts.testnet = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`不明なオプション: ${a}`);
    else opts.address = a;
  }
  return opts;
}

// タイムゾーンzoneにおける日付dateStr(YYYY-MM-DD)の0時をUTCミリ秒に変換する
function zonedDayStartMs(dateStr, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error(`日付はYYYY-MM-DD形式で指定してください: ${dateStr}`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // guess時点でのzoneのオフセットを求めて補正(DST境界の誤差は無視できる範囲)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
  );
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return guess - (asIfUtc - guess);
}

function formatTime(ms, zone) {
  // sv-SEロケールは "YYYY-MM-DD HH:mm:ss" 形式になる
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(ms));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postInfo(url, body) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`Info API ${body.type} がHTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await sleep(1000 * 2 ** attempt);
  }
}

// startTime/endTimeを取るエンドポイントを、1レスポンスの件数上限を気にせず全件取得する。
// 前回の最大時刻を次のstartTimeにして(同一ミリ秒の取りこぼしを防ぐため+1しない)、キーで重複排除する。
async function fetchAllByTime(url, baseBody, startMs, endMs, keyOf, label) {
  const seen = new Map();
  let cursor = startMs;
  for (let page = 1; ; page++) {
    const batch = await postInfo(url, { ...baseBody, startTime: cursor, endTime: endMs });
    if (!Array.isArray(batch)) throw new Error(`${baseBody.type} の応答が配列ではありません: ${JSON.stringify(batch).slice(0, 200)}`);
    let added = 0;
    let maxTime = cursor;
    for (const item of batch) {
      const k = keyOf(item);
      if (!seen.has(k)) {
        seen.set(k, item);
        added++;
      }
      if (item.time > maxTime) maxTime = item.time;
    }
    process.stderr.write(`  ${label}: ${page}ページ目 ${batch.length}件(新規${added}) 累計${seen.size}\r`);
    if (added === 0 || maxTime >= endMs) break;
    // 1ページ全件が同一ミリ秒だと進まないので1ms進める(その場合は同時刻の残りを取りこぼす可能性がある)
    cursor = maxTime === cursor ? cursor + 1 : maxTime;
    await sleep(REQUEST_INTERVAL_MS);
  }
  process.stderr.write('\n');
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

// ---- 各データ種別の取得と平坦化 ----

async function getFills(url, user, startMs, endMs, tz) {
  const fills = await fetchAllByTime(
    url, { type: 'userFillsByTime', user, aggregateByTime: false }, startMs, endMs,
    (f) => `${f.tid}`, '約定',
  );
  if (fills.length >= 10000) {
    console.warn('  警告: 約定が10000件に達しました。APIの上限により、それより古い約定は取得できていない可能性があります。');
  }
  return fills.map((f) => ({
    datetime: formatTime(f.time, tz),
    time_ms: f.time,
    coin: f.coin, // 現物は "@107" や "PURR/USDC" の形式
    side: f.side === 'B' ? 'buy' : f.side === 'A' ? 'sell' : f.side,
    dir: f.dir, // Open Long / Close Short / Buy / Sell など
    px: f.px,
    sz: f.sz,
    notional: (Number(f.px) * Number(f.sz)).toString(),
    closed_pnl: f.closedPnl,
    fee: f.fee,
    fee_token: f.feeToken,
    builder_fee: f.builderFee ?? '',
    start_position: f.startPosition,
    crossed: f.crossed, // true=テイカー
    liquidation: f.liquidation ? 'true' : '',
    oid: f.oid,
    tid: f.tid,
    hash: f.hash,
  }));
}

async function getFunding(url, user, startMs, endMs, tz) {
  const rows = await fetchAllByTime(
    url, { type: 'userFunding', user }, startMs, endMs,
    (r) => `${r.time}|${r.delta?.coin}|${r.hash}`, 'ファンディング',
  );
  return rows.map((r) => ({
    datetime: formatTime(r.time, tz),
    time_ms: r.time,
    coin: r.delta.coin,
    usdc: r.delta.usdc, // 受取がプラス、支払がマイナス
    position_size: r.delta.szi,
    funding_rate: r.delta.fundingRate,
    n_samples: r.delta.nSamples ?? '',
    hash: r.hash,
  }));
}

async function getLedger(url, user, startMs, endMs, tz) {
  const rows = await fetchAllByTime(
    url, { type: 'userNonFundingLedgerUpdates', user }, startMs, endMs,
    (r) => `${r.time}|${r.hash}|${JSON.stringify(r.delta)}`, '入出金・送金',
  );
  // deltaの中身は種別(deposit/withdraw/spotTransfer/accountClassTransfer/vaultDeposit等)ごとに違うので、キーの和集合を列にする
  return rows.map((r) => {
    const { type, ...rest } = r.delta || {};
    const flat = {};
    for (const [k, v] of Object.entries(rest)) flat[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    return { datetime: formatTime(r.time, tz), time_ms: r.time, type, ...flat, hash: r.hash };
  });
}

async function getOrders(url, user, startMs, endMs, tz) {
  const rows = await postInfo(url, { type: 'historicalOrders', user });
  if (!Array.isArray(rows)) throw new Error('historicalOrders の応答が配列ではありません');
  process.stderr.write(`  注文履歴: ${rows.length}件(直近2000件まで)\n`);
  return rows
    .filter((r) => r.order && r.order.timestamp >= startMs && r.order.timestamp <= endMs)
    .sort((a, b) => a.order.timestamp - b.order.timestamp)
    .map(({ order: o, status, statusTimestamp }) => ({
      datetime: formatTime(o.timestamp, tz),
      time_ms: o.timestamp,
      coin: o.coin,
      side: o.side === 'B' ? 'buy' : o.side === 'A' ? 'sell' : o.side,
      order_type: o.orderType,
      limit_px: o.limitPx,
      orig_sz: o.origSz,
      remaining_sz: o.sz,
      tif: o.tif ?? '',
      reduce_only: o.reduceOnly,
      trigger_px: o.triggerPx ?? '',
      status,
      status_time: statusTimestamp ? formatTime(statusTimestamp, tz) : '',
      oid: o.oid,
      cloid: o.cloid ?? '',
    }));
}

const FETCHERS = { fills: getFills, funding: getFunding, ledger: getLedger, orders: getOrders };

// ---- 出力 ----

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const esc = (v) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

function summarize(results) {
  const lines = [];
  if (results.fills) {
    const byCoin = {};
    for (const f of results.fills) {
      const c = (byCoin[f.coin] ||= { n: 0, pnl: 0, fee: 0, vol: 0 });
      c.n++;
      c.pnl += Number(f.closed_pnl) || 0;
      // 手数料はfee_token建て。USDC以外(現物の受取トークン建て等)は合算せず件数だけ見る
      if (f.fee_token === 'USDC') c.fee += Number(f.fee) || 0;
      c.vol += Number(f.notional) || 0;
    }
    lines.push('約定(銘柄別): 件数 / 確定損益 / 手数料(USDC建てのみ) / 約定代金');
    let tp = 0, tf = 0;
    for (const [coin, c] of Object.entries(byCoin).sort((a, b) => b[1].vol - a[1].vol)) {
      lines.push(`  ${coin.padEnd(12)} ${String(c.n).padStart(6)}  ${c.pnl.toFixed(2).padStart(14)}  ${c.fee.toFixed(2).padStart(12)}  ${c.vol.toFixed(2).padStart(16)}`);
      tp += c.pnl; tf += c.fee;
    }
    lines.push(`  合計: 確定損益 ${tp.toFixed(2)} / 手数料 ${tf.toFixed(2)} / 差引 ${(tp - tf).toFixed(2)} USDC`);
  }
  if (results.funding) {
    const total = results.funding.reduce((s, r) => s + (Number(r.usdc) || 0), 0);
    lines.push(`ファンディング: ${results.funding.length}件 合計 ${total.toFixed(2)} USDC(プラス=受取)`);
  }
  if (results.ledger) lines.push(`入出金・送金: ${results.ledger.length}件`);
  if (results.orders) lines.push(`注文履歴: ${results.orders.length}件`);
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf-8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  if (!opts.address || !/^0x[0-9a-fA-F]{40}$/.test(opts.address)) {
    throw new Error('アドレス(0x + 40桁16進)を引数か HYPERLIQUID_ADDRESS で指定してください');
  }
  for (const t of opts.types) if (!FETCHERS[t]) throw new Error(`不明な種別: ${t}(fills/funding/ledger/orders)`);
  if (!['csv', 'json'].includes(opts.format)) throw new Error('--format は csv か json');

  const url = process.env.HYPERLIQUID_API_URL || (opts.testnet ? TESTNET_URL : MAINNET_URL);
  const user = opts.address.toLowerCase();
  const startMs = zonedDayStartMs(opts.from, opts.tz);
  const endMs = opts.to ? zonedDayStartMs(opts.to, opts.tz) + 86400000 - 1 : Date.now();
  if (endMs < startMs) throw new Error('--to が --from より前です');

  console.log(`アドレス ${user}`);
  console.log(`期間 ${formatTime(startMs, opts.tz)} 〜 ${formatTime(endMs, opts.tz)} (${opts.tz})`);

  fs.mkdirSync(opts.out, { recursive: true });
  const results = {};
  for (const t of opts.types) {
    results[t] = await FETCHERS[t](url, user, startMs, endMs, opts.tz);
    const file = path.join(opts.out, `${user.slice(0, 10)}_${t}.${opts.format}`);
    fs.writeFileSync(file, opts.format === 'json' ? JSON.stringify(results[t], null, 2) : toCsv(results[t]));
    console.log(`  → ${file} (${results[t].length}件)`);
    await sleep(REQUEST_INTERVAL_MS);
  }
  console.log('\n' + summarize(results));
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
