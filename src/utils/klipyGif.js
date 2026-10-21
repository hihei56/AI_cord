// Klipy(https://klipy.com)のGIF検索APIからキーワードに合うGIFをランダムに1つ取得する。
// 元々はTenor(Google)を使っていたが、Tenor APIは2026年6月30日付で完全に終了した
// (2026年1月13日以降は新規APIキー発行も停止)。KlipyはTenor社の元社員が立ち上げた
// 後継サービスで、エンドポイント構成がTenorとほぼ互換(ドロップイン移行を謳っている)、
// 無料枠に利用上限が無い。要 .env の KLIPY_API_KEY(https://klipy.com/developers で取得)。
const logger = require('./logger');

const BASE_URL = 'https://api.klipy.com/api/v1';

// キーワードごとに直近選んだGIFのidを覚えておき、同じ検索結果プールから
// 短期間に同じGIFを繰り返し選んでしまうのを緩和する
const recentByQuery = new Map();
const RECENT_MAX = 8;

// 実機での動作確認により、実際のレスポンス形式は以下だと確認できた:
// { result: true, data: { data: [ { id, slug, title, file: { hd|md|sm: { gif|webp|jpg|mp4|webm: { url, width, height, size } } } } ] } }
// (公式ドキュメントに直接アクセスできない環境だったため、当初は"files"(複数形)
// 等の推測混じりの実装だったが、実際のフィールド名は"file"(単数形)だった。
// 万が一レスポンス形式が将来変わった場合にも壊れにくいよう、フォールバックの
// 候補は残しつつ確認済みの形を優先する)
function extractResults(data) {
  if (Array.isArray(data?.data?.data)) return data.data.data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return null;
}

function extractGifUrl(item) {
  return (
    item?.file?.md?.gif?.url ||
    item?.file?.sm?.gif?.url ||
    item?.file?.hd?.gif?.url ||
    item?.files?.gif?.url ||
    item?.files?.md?.gif?.url ||
    item?.url ||
    item?.src ||
    null
  );
}

async function fetchRandomGif(query) {
  const apiKey = process.env.KLIPY_API_KEY;
  if (!apiKey || !query) return null;

  try {
    // customer_idは「アプリ側で決める安定したユーザー識別子」として要求される
    // (Klipy側の重複排除・パーソナライズ用)。人間のユーザー単位の概念が無い
    // botなので、固定値で構わない
    const url = `${BASE_URL}/${apiKey}/gifs/search?q=${encodeURIComponent(query)}&customer_id=ai_cord&per_page=20&content_filter=medium`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      logger.error('GIF', `Klipy HTTP ${res.status} ${res.statusText} (query=${query})`);
      return null;
    }

    const data = await res.json();
    const results = extractResults(data);
    if (!results) {
      logger.error('GIF', `Klipy応答の形式が想定と異なるため解析できません(query=${query}): ${JSON.stringify(data).slice(0, 500)}`);
      return null;
    }
    if (results.length === 0) return null;

    const recent = recentByQuery.get(query) || [];
    const candidates = results.filter((r) => !recent.includes(r.id));
    const pool = candidates.length > 0 ? candidates : results;
    const picked = pool[Math.floor(Math.random() * pool.length)];

    const gifUrl = extractGifUrl(picked);
    if (!gifUrl) {
      logger.error('GIF', `Klipyの結果からGIF URLを取り出せませんでした(query=${query}): ${JSON.stringify(picked).slice(0, 500)}`);
      return null;
    }

    recent.push(picked.id);
    if (recent.length > RECENT_MAX) recent.shift();
    recentByQuery.set(query, recent);

    return gifUrl;
  } catch (err) {
    logger.error('GIF', err);
    return null;
  }
}

function resolveChance(base, jitterRatio) {
  const chance = base * (1 + (Math.random() * 2 - 1) * jitterRatio);
  return Math.min(1, Math.max(0, chance));
}

// accountState.gifGenres(.envのGIF_GENRE[_N]初期値+!gifgenreコマンドでの追加分)が
// 設定されているアカウントだけ対象。確率(base±jitterRatio)に当たったら、複数
// キーワードからランダムに1つ選んでGIFを取得する。未設定/ハズレ/取得失敗ならnullを
// 返し、呼び出し側は従来通りテキスト生成にフォールバックする
async function tryFetchGenreGif(accountState, base, jitterRatio = 0.4) {
  if (!base || !accountState?.gifGenres?.length) return null;
  if (Math.random() > resolveChance(base, jitterRatio)) return null;
  const genre = accountState.gifGenres[Math.floor(Math.random() * accountState.gifGenres.length)];
  return fetchRandomGif(genre);
}

module.exports = { fetchRandomGif, tryFetchGenreGif };
