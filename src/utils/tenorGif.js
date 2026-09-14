// Tenor(Google)の公式GIF検索APIからキーワードに合うGIFをランダムに1つ取得する。
// 無料・公式提供のAPIで、チャットアプリへの埋め込みは想定された利用方法そのもの
// (要 .env の TENOR_API_KEY。https://developers.google.com/tenor/guides/quickstart で取得)
const logger = require('./logger');

const BASE_URL = 'https://tenor.googleapis.com/v2/search';

// キーワードごとに直近選んだGIFのidを覚えておき、同じ検索結果プールから
// 短期間に同じGIFを繰り返し選んでしまうのを緩和する
const recentByQuery = new Map();
const RECENT_MAX = 8;

async function fetchRandomGif(query) {
  const apiKey = process.env.TENOR_API_KEY;
  if (!apiKey || !query) return null;

  try {
    const url = `${BASE_URL}?q=${encodeURIComponent(query)}&key=${apiKey}&limit=20&media_filter=gif&contentfilter=medium&locale=ja_JP`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      logger.error('GIF', `Tenor HTTP ${res.status} ${res.statusText} (query=${query})`);
      return null;
    }

    const data = await res.json();
    const results = data.results || [];
    if (results.length === 0) return null;

    const recent = recentByQuery.get(query) || [];
    const candidates = results.filter((r) => !recent.includes(r.id));
    const pool = candidates.length > 0 ? candidates : results;
    const picked = pool[Math.floor(Math.random() * pool.length)];

    recent.push(picked.id);
    if (recent.length > RECENT_MAX) recent.shift();
    recentByQuery.set(query, recent);

    return picked.media_formats?.gif?.url || picked.media_formats?.mediumgif?.url || null;
  } catch (err) {
    logger.error('GIF', err);
    return null;
  }
}

function resolveChance(base, jitterRatio) {
  const chance = base * (1 + (Math.random() * 2 - 1) * jitterRatio);
  return Math.min(1, Math.max(0, chance));
}

// accountState.gifGenres(.envのGIF_GENRE[_N]、カンマ区切りで複数可)が設定されて
// いるアカウントだけ対象。確率(base±jitterRatio)に当たったら、複数キーワードから
// ランダムに1つ選んでGIFを取得する。未設定/ハズレ/取得失敗ならnullを返し、
// 呼び出し側は従来通りテキスト生成にフォールバックする
async function tryFetchGenreGif(accountState, base, jitterRatio = 0.4) {
  if (!base || !accountState?.gifGenres?.length) return null;
  if (Math.random() > resolveChance(base, jitterRatio)) return null;
  const genre = accountState.gifGenres[Math.floor(Math.random() * accountState.gifGenres.length)];
  return fetchRandomGif(genre);
}

module.exports = { fetchRandomGif, tryFetchGenreGif };
