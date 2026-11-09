const logger = require('./logger');

// 自律エージェントの「調べてから話題にする」行動用のWeb検索。
// Tavily(https://tavily.com、無料枠あり)をTAVILY_API_KEYで使う。
// キーが未設定なら isAvailable() が false になり、エージェントは検索系の行動を
// 選択肢にすら出さない(キー無しで呼んで毎回失敗→トークンだけ消費、を防ぐ)
const ENDPOINT = 'https://api.tavily.com/search';

function isAvailable() {
  return Boolean(process.env.TAVILY_API_KEY);
}

// 戻り値: { answer, results: [{ title, url, content }] } または null
async function search(query, { maxResults = 3 } = {}) {
  if (!isAvailable() || !query) return null;
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

module.exports = { isAvailable, search, summarize };
