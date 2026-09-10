const logger = require('./logger');

// NHKニュースの総合RSS。無料・APIキー不要・公式のニュースフィード
const FEED_URL = 'https://www.nhk.or.jp/rss/news/cat0.xml';
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30分ごとに再取得(頻繁に叩きすぎない)

let cachedHeadlines = [];
let lastFetchedAt = 0;

// 簡易的な<title>抽出。RSS 2.0では<item>ブロック内にだけ記事の<title>があり、
// <channel>直下のフィード全体のタイトルは<item>より前に出てくるため、
// 最初の<item>で分割すればフィードタイトルを誤って拾うことはない
function parseHeadlines(xml) {
  const items = xml.split('<item>').slice(1);
  return items
    .map((item) => {
      const match = item.match(/<title>([\s\S]*?)<\/title>/);
      if (!match) return null;
      return match[1].replace('<![CDATA[', '').replace(']]>', '').trim();
    })
    .filter(Boolean);
}

async function refreshHeadlines() {
  try {
    const res = await fetch(FEED_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      logger.error('NEWS', `HTTP ${res.status} ${res.statusText}`);
      return;
    }
    const xml = await res.text();
    const headlines = parseHeadlines(xml);
    if (headlines.length > 0) {
      cachedHeadlines = headlines;
      lastFetchedAt = Date.now();
      logger.log('NEWS', `見出しを${headlines.length}件取得`);
    }
  } catch (err) {
    logger.error('NEWS', err);
  }
}

// キャッシュが古ければ更新してから、ランダムな見出しを1つ返す。
// 取得に失敗している間は前回のキャッシュを使い回し、一度も取得できていなければnull
async function getRandomHeadline() {
  if (Date.now() - lastFetchedAt > REFRESH_INTERVAL_MS) {
    await refreshHeadlines();
  }
  if (cachedHeadlines.length === 0) return null;
  return cachedHeadlines[Math.floor(Math.random() * cachedHeadlines.length)];
}

module.exports = { getRandomHeadline };
