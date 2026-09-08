// 会話生成に使うAIプロバイダ(groq/gemini)の接続情報を一元管理する。
// .envのGROQ_API_KEY/GEMINI_API_KEYを両方入れておけば、!provider コマンドで
// .envの書き換え・再起動なしにプロセス実行中に切り替えられる(全アカウント共通)。
// AI_PROVIDERは起動時点の初期値としてのみ使う。
const PROVIDER_DEFAULTS = {
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    model: 'openai/gpt-oss-120b',
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
  },
  cerebras: {
    label: 'Cerebras',
    // CerebrasはGroqと同じgpt-oss-120bを配信しており、1日の消費上限が緩い
    // (Groqの1日20万トークンに対し、Cerebrasは1日100万トークン程度と報告されている)。
    // 無料枠の条件(カード登録要否)は情報源により食い違うため、実際に
    // CEREBRAS_API_KEYを設定して動くかどうかで判断すること。
    // vision対応モデルは無いため、VISION_AI_PROVIDERで別プロバイダを明示指定推奨
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    model: 'gpt-oss-120b',
    visionModel: 'gpt-oss-120b'
  },
  nvidia: {
    label: 'NVIDIA NIM',
    // build.nvidia.comのOpenAI互換エンドポイント。無料枠は40RPM・1日10,000リクエスト、
    // 登録時に約1000クレジット付与(カード不要)だが、NVIDIA公式は「評価用途向け、
    // 本番トラフィック向けではない」と明記しているため、クレジットが尽きたら
    // 使えなくなる可能性がある。モデル名の命名規則(vendor/model形式)はカタログの
    // 変更が頻繁で、GET /v1/modelsに載っていても実際は404(アカウント未許可)に
    // なることがあるため、実際にchat/completionsで200が返るか確認して選定すること。
    // meta/llama-3.3-70b-instruct, nvidia/llama-3.1-nemotron-70b-instruct,
    // moonshotai/kimi-k2.6, mistralai/mistral-large-2-instruct, 90B/253B級の
    // 大型モデル等は404または実用にならないレイテンシだった。moonshotai/kimi-k3は
    // 一時動いたが、その後404になったり、reasoningがmax_tokensを使い切って
    // 本文が空(content: null)のまま終わることがあり不安定だったため不採用。
    // meta/llama-3.2-11b-vision-instructはreasoning無しで安定して動作確認できている
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    model: 'meta/llama-3.2-11b-vision-instruct',
    visionModel: 'meta/llama-3.2-11b-vision-instruct'
  },
  cloudflare: {
    label: 'Cloudflare Workers AI',
    // Cloudflareは接続先URLにAccount IDを含める必要があるため、他プロバイダと違い
    // baseUrlを動的に組み立てる(CLOUDFLARE_ACCOUNT_IDが無ければ空文字のまま=
    // 実質使用不可になる)。無料枠は1日10,000ニューロン(全モデル共通のプール、
    // モデルサイズによって消費速度が変わる)、40RPM相当。実機でllama-3.3-70b-
    // instruct-fp8-fastの動作を確認済み(llama-3.1-8b-instructは廃止済みだった)
    baseUrl: process.env.CLOUDFLARE_ACCOUNT_ID
      ? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`
      : '',
    apiKeyEnv: 'CLOUDFLARE_API_KEY',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    visionModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
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
    // AI同士の掛け合いは大量に呼ばれるため、人間向け会話(currentProvider)とは
    // 別の余力があるプロバイダに逃がしたい。SEED_AI_PROVIDERで明示指定できるほか、
    // 未指定なら「現在のプロバイダ以外でAPIキーが設定済みのもの」を自動で選ぶ
    // (PROVIDER_DEFAULTSの定義順)。他に無ければ現在のプロバイダを使い回す
    const otherAvailable = availableProviders().find((name) => name !== currentProvider);
    const providerName = resolveProviderName(process.env.SEED_AI_PROVIDER) || otherAvailable || currentProvider;
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
