const logger = require('./logger');
const { todayJST } = require('./datetime');

// 自律エージェントの「調べてから話題にする」行動用のWeb検索。
// Tavily(https://tavily.com、無料枠あり)をTAVILY_API_KEYで使う。
// キーが未設定なら isAvailable() が false になり、エージェントは検索系の行動を
// 選択肢にすら出さない(キー無しで呼んで毎回失敗→トークンだけ消費、を防ぐ)
const ENDPOINT = 'https://api.tavily.com/search';

// 無料枠(Tavilyは月1000回程度)を使い切らないよう、1日の検索回数に上限を設ける
const MAX_PER_DAY = Number(process.env.SEARCH_MAX_PER_DAY) || 30;
let day = '';
let usedToday = 0;

function isAvailable() {
  if (!process.env.TAVILY_API_KEY) return false;
  if (day !== todayJST()) {
    day = todayJST();
    usedToday = 0;
  }
  return usedToday < MAX_PER_DAY;
}

// 同じ話題で何人もが同じことを聞いたり、複数アカウントが同じ発言を見て同じ検索をしたりするので、
// 同じクエリの結果はしばらく使い回す(無料枠の節約。結果が変わりやすい話題でも数時間なら十分新しい)
const CACHE_TTL_MS = 6 * 3600000;
const CACHE_MAX = 200;
const cache = new Map();
const normalize = (q) => q.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// 戻り値: { answer, results: [{ title, url, content }] } または null
async function search(query, { maxResults = 3 } = {}) {
  if (!query) return null;
  const key = normalize(query);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
  if (!isAvailable()) return null;
  usedToday++;
  const result = await fetchSearch(query, maxResults);
  if (result) {
    cache.set(key, { at: Date.now(), result });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return result;
}

async function fetchSearch(query, maxResults) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: 'basic',
        include_answer: true
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    if (!res.ok) {
      logger.error('SEARCH', `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    return {
      answer: data.answer || null,
      results: (data.results || []).map((r) => ({ title: r.title, url: r.url, content: (r.content || '').slice(0, 300) }))
    };
  } catch (err) {
    logger.error('SEARCH', err.message);
    return null;
  }
}

// プロンプトに渡す用の短い要約文字列
function summarize(result, maxLength = 400) {
  if (!result) return null;
  const text = result.answer || result.results.map((r) => `${r.title}: ${r.content}`).join(' / ');
  return text ? text.slice(0, maxLength) : null;
}

function usage() {
  isAvailable();
  return { usedToday, max: MAX_PER_DAY, cached: cache.size };
}

module.exports = { isAvailable, search, summarize, usage, _cache: cache };
