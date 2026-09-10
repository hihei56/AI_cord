const logger = require('./logger');

// よく使う銘柄のCoinGecko id。ここに無いものは検索APIで自動解決を試みる
const KNOWN_COINGECKO_IDS = {
  btc: 'bitcoin',
  zec: 'zcash'
};

const resolvedCache = new Map();

async function searchCoinGecko(symbol) {
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const match = data.coins?.find((c) => c.symbol?.toLowerCase() === symbol);
    return match ? { source: 'coingecko', id: match.id, name: match.name } : null;
  } catch (err) {
    logger.error('PRICE', err);
    return null;
  }
}

// CoinGeckoにまだ載っていない新興のDEX上のトークン(Solanaのミームコイン等)向けフォールバック。
// シンボル一致かつ流動性が最大のペアを採用する
async function searchDexScreener(symbol) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const candidates = (data.pairs || []).filter((p) => p.baseToken?.symbol?.toLowerCase() === symbol);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const best = candidates[0];
    return { source: 'dexscreener', chainId: best.chainId, pairAddress: best.pairAddress, name: best.baseToken.name };
  } catch (err) {
    logger.error('PRICE', err);
    return null;
  }
}

// 手動指定(overrides: CoinGecko id、または"チェーンID:ペアアドレス"形式)を最優先で使う。
// 無ければ既知一覧 → CoinGecko検索 → DexScreener検索の順で自動解決する(結果はキャッシュ)。
// ticker(シンボル)は同名の別トークンと衝突しうるため、自動解決に自信が持てない銘柄は
// !pricealert setid で手動指定してもらう前提の設計
async function resolveSymbol(symbol, manualOverride) {
  const s = symbol.toLowerCase();

  if (manualOverride) {
    if (manualOverride.includes(':')) {
      const [chainId, pairAddress] = manualOverride.split(':');
      return { source: 'dexscreener', chainId, pairAddress };
    }
    return { source: 'coingecko', id: manualOverride };
  }

  if (resolvedCache.has(s)) return resolvedCache.get(s);

  let resolved = KNOWN_COINGECKO_IDS[s] ? { source: 'coingecko', id: KNOWN_COINGECKO_IDS[s] } : null;
  if (!resolved) resolved = await searchCoinGecko(s);
  if (!resolved) resolved = await searchDexScreener(s);

  // 解決に失敗した場合(一時的なネットワークエラー・APIのレート制限等も含む)は
  // キャッシュしない。キャッシュしてしまうと、原因が一時的なものでも次回以降の
  // チェックで自動的に再試行されず、プロセスを再起動するか!pricealert setidで
  // 手動指定するまで永久に「取得失敗」のまま固定されてしまうため
  if (!resolved) {
    logger.error('PRICE', `銘柄"${symbol}"を自動解決できませんでした(CoinGecko/DexScreenerとも該当なし)`);
    return null;
  }

  resolvedCache.set(s, resolved);
  return resolved;
}

async function fetchCoinGeckoPrices(ids, currency) {
  if (ids.length === 0) return {};
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=${currency}&include_24hr_change=true`
    );
    if (!res.ok) {
      logger.error('PRICE', `CoinGecko HTTP ${res.status}`);
      return {};
    }
    return await res.json();
  } catch (err) {
    logger.error('PRICE', err);
    return {};
  }
}

async function fetchDexScreenerPair(chainId, pairAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.[0] || data.pair;
    if (!pair) return null;
    return { price: Number(pair.priceUsd), change24h: pair.priceChange?.h24 };
  } catch (err) {
    logger.error('PRICE', err);
    return null;
  }
}

// symbols: ['btc','ponz',...], overrides: { ponz: 'solana:xxxx' } のような手動指定(任意)
// -> { btc: { usd: 12345, usd_24h_change: 1.2 }, ... } (解決できたものだけ)
// DexScreener由来の価格は常にUSD建てなので、currencyにusd以外を指定した場合はそのまま近似値として扱う
async function fetchPrices(symbols, currency = 'usd', overrides = {}) {
  const resolutions = {};
  for (const s of symbols) {
    resolutions[s] = await resolveSymbol(s, overrides[s]);
  }

  const coingeckoIds = [...new Set(Object.values(resolutions).filter((r) => r?.source === 'coingecko').map((r) => r.id))];
  const cgData = await fetchCoinGeckoPrices(coingeckoIds, currency);

  const result = {};
  for (const [symbol, resolution] of Object.entries(resolutions)) {
    if (!resolution) continue;

    if (resolution.source === 'coingecko') {
      const d = cgData[resolution.id];
      if (d && d[currency] !== undefined) {
        result[symbol] = { [currency]: d[currency], [`${currency}_24h_change`]: d[`${currency}_24h_change`] };
      }
    } else if (resolution.source === 'dexscreener') {
      const d = await fetchDexScreenerPair(resolution.chainId, resolution.pairAddress);
      if (d && Number.isFinite(d.price)) {
        result[symbol] = { [currency]: d.price, [`${currency}_24h_change`]: d.change24h };
      }
    }
  }
  return result;
}

module.exports = { resolveSymbol, fetchPrices };
