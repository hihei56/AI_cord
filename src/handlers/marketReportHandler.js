const config = require('../utils/config');
const logger = require('../utils/logger');
const store = require('../utils/marketReportStore');
const { fetchDailyCloses, fetchSp500Per, fetchMarketHeadlines, rsi, analyzeMovingAverages } = require('../utils/marketData');
const { callChatCompletion } = require('../utils/aiClient');
const { hourOfDayJST, todayJST } = require('../utils/datetime');

const DEFAULTS = {
  indices: [
    { symbol: '^NDX', label: 'NASDAQ100' },
    { symbol: '^GSPC', label: 'S&P500' }
  ],
  maPeriods: [50, 120, 200],
  touchPercent: 1,
  rsiPeriod: 14,
  vixAlert: 30,
  postHourJST: 7,
  checkIntervalMs: 600000,
  aiSummary: true
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

const EVENT_TEXT = {
  cross_up: '終値が下から上抜け',
  cross_down: '終値が上から割り込み',
  approach_from_above: '上から±{t}%以内に接近',
  approach_from_below: '下から±{t}%以内に接近'
};

function describeIndex(label, data, s) {
  const closes = data.bars.map((b) => b.close);
  const close = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const change = ((close - prev) / prev) * 100;
  const mas = analyzeMovingAverages(closes, s.maPeriods, s.touchPercent);
  const r = rsi(closes, s.rsiPeriod);

  const maLine = mas
    .filter((m) => m.ma !== null)
    .map((m) => `${m.period}日線 ${signed(m.diffPercent)}%${m.slope === 'down' ? '↘' : ''}`)
    .join(' / ');

  let rsiNote = '';
  if (r !== null && r >= 70) rsiNote = '(買われすぎ圏)';
  else if (r !== null && r <= 30) rsiNote = '(売られすぎ圏)';

  const lines = [
    `**${label}** ${fmt(close)} (${signed(change, 2)}%)${data.provisional ? ' ※取引中の暫定値' : ''}`,
    `　${maLine}`,
    `　RSI(${s.rsiPeriod}) ${fmt(r, 1)}${rsiNote}`
  ];

  const events = mas
    .filter((m) => m.event)
    .map((m) => {
      const text = EVENT_TEXT[m.event].replace('{t}', s.touchPercent);
      const slopeNote = m.slope === 'down' ? '、この線自体は下向き' : '';
      return `⚠️ ${label} ${m.period}日線: ${text}(乖離 ${signed(m.diffPercent)}%${slopeNote})`;
    });
  if (r !== null && (r >= 70 || r <= 30)) events.push(`⚠️ ${label} RSI ${fmt(r, 1)}${rsiNote}`);

  return { lines, events, change, tradingDay: tradingDayOf(data.bars[data.bars.length - 1].time) };
}

// 見出しだけを根拠に「なぜ動いたか」を要約させる。予想・売買推奨はさせない
// (見出しに無いことをLLMにもっともらしく補完させると誤情報になるため)
async function summarizeHeadlines(headlines, moves) {
  if (headlines.length === 0) return null;
  const prompt = [
    '以下は米国株式市場のニュース見出しと、前日の主要指数の騰落率です。',
    '見出しに書かれている事実だけを根拠に、指数が動いた主な理由を日本語の箇条書き(「・」始まり)で最大3行にまとめてください。',
    '見出しから理由が読み取れない場合は「・見出しからは明確な理由は読み取れず」とだけ書いてください。',
    '今後の相場予想、売買の推奨、見出しに無い情報の補足は一切しないでください。',
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
  return text;
}

// レポート本文を組み立てる。株価が1つも取れなければnull
async function buildReport() {
  const s = settings();
  const [vixData, per, headlines, ...indexData] = await Promise.all([
    fetchDailyCloses('^VIX'),
    fetchSp500Per(),
    fetchMarketHeadlines(s.indices.map((i) => i.symbol)),
    ...s.indices.map((i) => fetchDailyCloses(i.symbol))
  ]);

  const described = [];
  const failed = [];
  s.indices.forEach((idx, i) => {
    const data = indexData[i];
    if (data && data.bars.length >= 2) described.push({ label: idx.label, ...describeIndex(idx.label, data, s) });
    else failed.push(idx.label);
  });
  if (described.length === 0) return null;

  const tradingDay = described[0].tradingDay;
  const lines = [`📊 米国株 市況まとめ(${tradingDay} 取引分)`];
  for (const d of described) lines.push(...d.lines);
  if (failed.length) lines.push(`(${failed.join('・')}は取得失敗)`);

  const events = described.flatMap((d) => d.events);
  if (vixData) {
    const vix = vixData.bars[vixData.bars.length - 1].close;
    lines.push(`VIX ${fmt(vix)}${vix >= s.vixAlert ? ' (警戒水準)' : ''}`);
    if (vix >= s.vixAlert) events.push(`⚠️ VIX ${fmt(vix)}(${s.vixAlert}以上)`);
  }
  if (per) lines.push(`S&P500 実績PER ${fmt(per)}倍`);

  if (events.length) lines.push('', ...events);

  if (s.aiSummary && headlines.length) {
    const moves = described.map((d) => `${d.label} ${signed(d.change, 2)}%`).join(', ');
    const summary = await summarizeHeadlines(headlines, moves);
    if (summary) lines.push('', 'なぜ動いた?(ニュース見出しからAIが要約)', summary);
    lines.push(...headlines.slice(0, 3).filter((h) => h.link).map((h) => `🔗 <${h.link}>`));
  }

  // Discordの1メッセージ上限(2000文字)を超えないよう切り詰める
  let text = lines.join('\n');
  if (text.length > 1990) text = `${text.slice(0, 1987)}...`;
  return { text, tradingDay };
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
