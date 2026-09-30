const config = require('../utils/config');
const logger = require('../utils/logger');
const store = require('../utils/marketReportStore');
const { fetchDailyCloses, fetchSp500Per, fetchMarketHeadlines, rsi, detectDips, formatDip } = require('../utils/marketData');
const { callChatCompletion } = require('../utils/aiClient');
const { hourOfDayJST, todayJST } = require('../utils/datetime');

const DEFAULTS = {
  indices: [
    { symbol: '^NDX', label: 'N100' },
    { symbol: '^GSPC', label: 'P500' }
  ],
  maPeriods: [50, 120, 200],
  touchPercent: 1,
  rsiPeriod: 14,
  vixAlert: 30,
  postHourJST: 7,
  checkIntervalMs: 600000,
  aiSummary: false
};

function settings() {
  return { ...DEFAULTS, ...(config.marketReport || {}) };
}

// バーの時刻は米国の取引日の寄り付き時刻なので、ニューヨーク時間で日付にする
function tradingDayOf(timeMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(timeMs));
}

function fmt(v, digits = 2) {
  return Number.isFinite(v) ? v.toLocaleString('ja-JP', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '?';
}

function signed(v, digits = 1) {
  return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(digits)}` : '?';
}

// 平常時は「終値と前日比」の1行だけ。押し目・RSIの過熱は起きた日だけ行を足す
function describeIndex(label, data, s) {
  const closes = data.bars.map((b) => b.close);
  const close = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const change = ((close - prev) / prev) * 100;
  const r = rsi(closes, s.rsiPeriod);

  const line = `${label} ${fmt(close, 0)} (${signed(change)}%)${data.provisional ? ' ※取引中' : ''}`;

  const events = detectDips(closes, s.maPeriods, s.touchPercent).map((d) => formatDip(label, d));
  if (r !== null && r >= 70) events.push(`🔥${label} RSI${fmt(r, 0)}`);
  else if (r !== null && r <= 30) events.push(`🧊${label} RSI${fmt(r, 0)}`);

  return { line, events, change, tradingDay: tradingDayOf(data.bars[data.bars.length - 1].time) };
}

// 見出しだけを根拠に「なぜ動いたか」を1行で要約させる。予想・売買推奨はさせない
// (見出しに無いことをLLMにもっともらしく補完させると誤情報になるため)
async function summarizeHeadlines(headlines, moves) {
  if (headlines.length === 0) return null;
  const prompt = [
    '以下は米国株式市場のニュース見出しと、前日の主要指数の騰落率です。',
    '見出しに書かれている事実だけを根拠に、指数が動いた主な理由を日本語で1文(40文字以内)にまとめてください。',
    '見出しから理由が読み取れない場合は「不明」とだけ書いてください。',
    '今後の相場予想、売買の推奨、見出しに無い情報の補足は一切しないでください。前置きや記号は付けないでください。',
    '',
    `騰落率: ${moves}`,
    '見出し:',
    ...headlines.map((h) => `- ${h.title}`)
  ].join('\n');

  // 'seed'は人間との会話用とは別のトークン枠を使う接続(aiProvider.getConnection参照)
  const text = await callChatCompletion([{ role: 'user', content: prompt }], {
    temperature: 0.2,
    maxTokens: 800,
    logTag: 'MARKET',
    kind: 'seed'
  });
  if (!text) return null;
  const firstLine = text.split('\n').map((l) => l.replace(/^[・\-*\s]+/, '').trim()).find(Boolean);
  return firstLine && firstLine !== '不明' ? firstLine : null;
}

// レポート本文を組み立てる。株価が1つも取れなければnull
async function buildReport() {
  const s = settings();
  const [vixData, per, headlines, ...indexData] = await Promise.all([
    fetchDailyCloses('^VIX'),
    fetchSp500Per(),
    s.aiSummary ? fetchMarketHeadlines(s.indices.map((i) => i.symbol)) : [],
    ...s.indices.map((i) => fetchDailyCloses(i.symbol))
  ]);

  const described = [];
  s.indices.forEach((idx, i) => {
    const data = indexData[i];
    if (data && data.bars.length >= 2) described.push(describeIndex(idx.label, data, s));
  });
  if (described.length === 0) return null;

  const tradingDay = described[0].tradingDay;
  const lines = described.map((d) => d.line);

  const events = described.flatMap((d) => d.events);
  const vix = vixData ? vixData.bars[vixData.bars.length - 1].close : null;
  const extras = [vix !== null ? `VIX ${fmt(vix, 1)}${vix >= s.vixAlert ? '!' : ''}` : null, per ? `PER ${fmt(per, 1)}` : null].filter(Boolean);
  if (extras.length) lines.push(extras.join(' / '));

  if (headlines.length) {
    const moves = described.map((d) => d.line).join(', ');
    const summary = await summarizeHeadlines(headlines, moves);
    if (summary) lines.push(`理由: ${summary}`);
  }

  lines.push(...events);
  return { text: lines.join('\n'), tradingDay };
}

// 日本時間でpostHourJSTを過ぎたら1日1回だけチェックし、前回投稿時と米国の
// 取引日が変わっていれば投稿する(米国休場明けでなければスキップ)
async function checkOnce(client) {
  const s = settings();
  const channelId = store.getChannelId();
  if (!channelId) return;
  const channel = client.channels?.cache.get(channelId);
  if (!channel) return;

  const today = todayJST();
  if (hourOfDayJST() < s.postHourJST || store.getLastCheckedDate() === today) return;

  const report = await buildReport();
  // 取得失敗時は「チェック済み」にせず、次のチェック間隔で再試行する
  if (!report) return;
  store.setLastCheckedDate(today);
  if (report.tradingDay === store.getLastReportedTradingDay()) return;

  try {
    await channel.send(report.text);
    store.setLastReportedTradingDay(report.tradingDay);
    logger.log('MARKET', `市況まとめを投稿 (${report.tradingDay})`);
  } catch (err) {
    logger.error('MARKET', err);
  }
}

// 市況まとめはアカウント(persona)に依存しない全体機能なので、
// clients[0]だけが投稿を担当する(priceAlertHandlerと同じ方針)
function registerMarketReportHandler(clients) {
  if (!config.marketReport?.enabled) return;
  const client = clients[0];
  if (!client) return;

  const { checkIntervalMs } = settings();
  setInterval(() => checkOnce(client).catch((err) => logger.error('MARKET', err)), checkIntervalMs);
}

module.exports = { registerMarketReportHandler, buildReport, checkOnce };
