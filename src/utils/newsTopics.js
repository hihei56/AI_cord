const config = require('./config');
const logger = require('./logger');

// NHKニュースのRSS。無料・APIキー不要・公式のニュースフィード。
// 総合(cat0)に加えて経済(cat5)を取る。AI同士の会話のお題に、株価・為替・企業・物価などの
// 経済ニュースを中身(見出し+概要)ごと渡して、当たり障りのない世間話だけにならないようにする
const FEEDS = {
  general: 'https://www.nhk.or.jp/rss/news/cat0.xml',
  economy: 'https://www.nhk.or.jp/rss/news/cat5.xml',
  ...(config.news?.feeds || {})
};
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30分ごとに再取得(頻繁に叩きすぎない)
const FETCH_TIMEOUT_MS = 8000;
const DESCRIPTION_MAX_LENGTH = 160;

// カテゴリ → [{ title, description }]
const cache = {};
let lastFetchedAt = 0;

function textOf(item, tag) {
  const match = item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) return '';
  return match[1]
    .replace('<![CDATA[', '')
    .replace(']]>', '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// RSS 2.0では<item>ブロック内にだけ記事の<title>があり、<channel>直下のフィード全体の
// タイトルは<item>より前に出てくるため、最初の<item>で分割すればフィードタイトルを拾わない
function parseItems(xml) {
  return xml
    .split('<item>')
    .slice(1)
    .map((item) => ({ title: textOf(item, 'title'), description: textOf(item, 'description').slice(0, DESCRIPTION_MAX_LENGTH) }))
    .filter((it) => it.title);
}

async function refreshFeed(category, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      logger.error('NEWS', `${category}: HTTP ${res.status} ${res.statusText}`);
      return;
    }
    const items = parseItems(await res.text());
    if (items.length > 0) {
      cache[category] = items;
      logger.log('NEWS', `${category}: ${items.length}件取得`);
    }
  } catch (err) {
    logger.error('NEWS', `${category}: ${err.message}`);
  }
}

// キャッシュが古ければ全フィードを取り直す。失敗したフィードは前回のキャッシュを使い回す
async function ensureFresh() {
  if (Date.now() - lastFetchedAt <= REFRESH_INTERVAL_MS) return;
  lastFetchedAt = Date.now();
  await Promise.all(Object.entries(FEEDS).map(([category, url]) => refreshFeed(category, url)));
}

function shuffled(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

// 見出しだけをランダムに1つ(総合ニュースから。無ければ他のカテゴリから)
async function getRandomHeadline() {
  await ensureFresh();
  const pool = cache.general?.length ? cache.general : Object.values(cache).flat();
  return pool.length ? pool[Math.floor(Math.random() * pool.length)].title : null;
}

// 会話のお題用に { title, description } をcount件。categoryを優先し、足りなければ他から補う
async function getNewsItems(count, category = 'economy') {
  await ensureFresh();
  const preferred = shuffled(cache[category] || []);
  const others = shuffled(Object.entries(cache).filter(([c]) => c !== category).flatMap(([, items]) => items));
  return [...preferred, ...others].slice(0, count);
}

module.exports = { getRandomHeadline, getNewsItems };
