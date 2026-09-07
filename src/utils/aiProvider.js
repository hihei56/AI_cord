// 会話生成に使うAIプロバイダ(groq/gemini)の接続情報を一元管理する。
// .envのGROQ_API_KEY/GEMINI_API_KEYを両方入れておけば、!provider コマンドで
// .envの書き換え・再起動なしにプロセス実行中に切り替えられる(全アカウント共通)。
// AI_PROVIDERは起動時点の初期値としてのみ使う。
const PROVIDER_DEFAULTS = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    // gpt-oss-120bはreasoningモデルで消費が重く1日20万トークンですぐ枯渇するため、
    // reasoning無しで1日50万トークンまで使えるllama-3.1-8b-instantを既定にする
    model: 'llama-3.1-8b-instant',
    visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct'
  },
  gemini: {
    label: 'Gemini',
    // GeminiのOpenAI互換エンドポイント。呼び出し側で`${baseUrl}/chat/completions`と
    // 連結するため、末尾スラッシュは付けない。
    // gemini-2.5-flashは新規ユーザーに提供終了済み(404: "no longer available to
    // new users")。Google側の案内に従いgemini-3.6-flashを使う
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    model: 'gemini-3.6-flash',
    visionModel: 'gemini-3.6-flash'
  }
};

function resolveProviderName(name) {
  const key = (name || '').toLowerCase();
  return PROVIDER_DEFAULTS[key] ? key : null;
}

function apiKeyFor(providerName) {
  return process.env[PROVIDER_DEFAULTS[providerName].apiKeyEnv];
}

// 対応するAPIキーが.envに入っているプロバイダだけを「切り替え可能」とする
function availableProviders() {
  return Object.keys(PROVIDER_DEFAULTS).filter((name) => Boolean(apiKeyFor(name)));
}

let currentProvider = resolveProviderName(process.env.AI_PROVIDER) || availableProviders()[0] || 'groq';

function getProvider() {
  return currentProvider;
}

// APIキーが.envに設定されているプロバイダにしか切り替えられない(設定ミスで
// 空のAPIキーのまま動き続けるのを防ぐため)
function setProvider(name) {
  const resolved = resolveProviderName(name);
  if (!resolved) return { ok: false, reason: `未対応のプロバイダ: ${name} (対応: ${Object.keys(PROVIDER_DEFAULTS).join(', ')})` };
  if (!apiKeyFor(resolved) && !process.env.AI_API_KEY) {
    return { ok: false, reason: `${PROVIDER_DEFAULTS[resolved].apiKeyEnv}が.envに未設定です` };
  }
  currentProvider = resolved;
  return { ok: true };
}

// kind: 'chat'(通常の会話生成) | 'vision'(画像解析) | 'seed'(AI同士の掛け合い)。
// visionはVISION_AI_PROVIDERで個別に指定できる(未指定なら現在の会話用プロバイダを
// そのまま使い回す)。seedはSEED_AI_PROVIDERで指定でき、未指定でもGEMINI_API_KEYが
// あれば自動でGeminiを使う。AI同士の掛け合いはalwaysOnモードで常時大量に呼ばれ、
// 人間との会話用のGroqトークン枠(1日20万トークン)を食い潰してしまうため、
// 掛け合い分だけ別プロバイダに逃がせるようにしている
function getConnection(kind = 'chat') {
  if (kind === 'vision') {
    const providerName = resolveProviderName(process.env.VISION_AI_PROVIDER) || currentProvider;
    const p = PROVIDER_DEFAULTS[providerName];
    return {
      provider: providerName,
      baseUrl: process.env.VISION_API_BASE_URL || process.env.AI_BASE_URL || p.baseUrl,
      apiKey: process.env.VISION_API_KEY || process.env.AI_API_KEY || apiKeyFor(providerName) || process.env.GROQ_API_KEY,
      model: process.env.VISION_MODEL || p.visionModel
    };
  }

  if (kind === 'seed') {
    const providerName = resolveProviderName(process.env.SEED_AI_PROVIDER) || (apiKeyFor('gemini') ? 'gemini' : currentProvider);
    const p = PROVIDER_DEFAULTS[providerName];
    return {
      provider: providerName,
      baseUrl: process.env.SEED_API_BASE_URL || p.baseUrl,
      apiKey: process.env.SEED_API_KEY || apiKeyFor(providerName) || process.env.GROQ_API_KEY,
      model: process.env.SEED_MODEL || p.model
    };
  }

  const p = PROVIDER_DEFAULTS[currentProvider];
  return {
    provider: currentProvider,
    baseUrl: process.env.AI_BASE_URL || p.baseUrl,
    apiKey: process.env.AI_API_KEY || apiKeyFor(currentProvider) || process.env.GROQ_API_KEY,
    model: process.env.AI_MODEL || p.model
  };
}

// getConnectionが返すプロバイダとは別の、APIキーが設定済みのプロバイダの接続情報を返す。
// レート制限(429)等で主プロバイダが失敗した時のフォールバック用。無ければnull
function getFallbackConnection(kind = 'chat') {
  const primary = getConnection(kind);
  const fallbackName = availableProviders().find((name) => name !== primary.provider);
  if (!fallbackName) return null;
  const p = PROVIDER_DEFAULTS[fallbackName];
  return {
    provider: fallbackName,
    baseUrl: p.baseUrl,
    apiKey: apiKeyFor(fallbackName),
    model: kind === 'vision' ? p.visionModel : p.model
  };
}

module.exports = { getProvider, setProvider, availableProviders, getConnection, getFallbackConnection, resolveProviderName };
