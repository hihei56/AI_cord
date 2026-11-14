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
  logfare: {
    label: 'Logfare',
    // https://logfare.ai の無料OpenAI互換API(レート制限なしを謳う)。運営者は不明で、
    // 第三者の報告では「全リクエスト(プロンプト・応答)を内部研究用に記録、/consentで
    // オプトアウト可」とされる。Discordの他人の発言を送ることになるので、人間への返信
    // (chat)の既定には使わず、バックグラウンド処理(エージェント・AI同士の掛け合い=seed)の
    // 逃がし先として使う想定。モデルIDは頻繁に変わるため、既定は空いているモデルへ自動で
    // 振り分ける logfare/auto にし、LOGFARE_MODELで固定できるようにする
    baseUrl: process.env.LOGFARE_BASE_URL || 'https://logfare.ai/v1',
    apiKeyEnv: 'LOGFARE_API_KEY',
    model: process.env.LOGFARE_MODEL || 'logfare/auto',
    visionModel: process.env.LOGFARE_MODEL || 'logfare/auto'
  },
  openrouter: {
    label: 'OpenRouter',
    // ':free'の付いたモデルが無料(1日の回数制限あり、課金履歴の有無で上限が変わる)。
    // 無料モデルのカタログは頻繁に入れ替わり、存在しないIDを既定値にすると404になるだけなので、
    // OPENROUTER_MODEL(例: 何らかのモデルID:free)を明示した時だけ使用可能扱いにする
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    model: process.env.OPENROUTER_MODEL || '',
    visionModel: process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL || ''
  },
  cloudflare: {
    label: 'Cloudflare Workers AI',
    // Cloudflareは接続先URLにAccount IDを含める必要があるため、他プロバイダと違い
    // baseUrlを動的に組み立てる(CLOUDFLARE_ACCOUNT_IDが無ければ空文字のまま=
    // 実質使用不可になる)。無料枠は1日10,000ニューロン(全モデル共通のプール、
    // モデルサイズによって消費速度が変わる)、40RPM相当。llama-3.3-70b-instruct-
    // fp8-fast(量子化・高速化版)は実際にトークンサラダ状態で出力が壊れる事例が
    // 複数回発生したため、Groqと同じ系統でこのセッションを通して安定していた
    // gpt-oss-120bに切り替えた
    baseUrl: process.env.CLOUDFLARE_ACCOUNT_ID
      ? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`
      : '',
    apiKeyEnv: 'CLOUDFLARE_API_KEY',
    model: '@cf/openai/gpt-oss-120b',
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

// 対応するAPIキー(とモデル名・接続先)が.envに入っているプロバイダだけを「切り替え可能」とする
function availableProviders() {
  return Object.keys(PROVIDER_DEFAULTS).filter(
    (name) => Boolean(apiKeyFor(name)) && Boolean(PROVIDER_DEFAULTS[name].model) && Boolean(PROVIDER_DEFAULTS[name].baseUrl)
  );
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
  if (!availableProviders().includes(resolved) && !process.env.AI_API_KEY) {
    const p = PROVIDER_DEFAULTS[resolved];
    return { ok: false, reason: `${p.apiKeyEnv}(と必要ならモデル名)が.envに未設定です` };
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
    // LOGFARE_API_KEYがあれば、レート制限の無いLogfareを最優先の逃がし先にする
    const otherAvailable = availableProviders().find((name) => name !== currentProvider);
    const preferred = apiKeyFor('logfare') && currentProvider !== 'logfare' ? 'logfare' : otherAvailable;
    const providerName = resolveProviderName(process.env.SEED_AI_PROVIDER) || preferred || currentProvider;
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

// getConnectionが返すプロバイダとは別の、APIキーが設定済みの全プロバイダの接続情報を
// 優先度順(PROVIDER_DEFAULTSの定義順)で返す。1つ目が429/404等で失敗しても次を
// 試せるよう、フォールバック候補を「1つだけ」ではなく「残り全部」返す設計にしている
// (以前は1つ試して失敗したらそこで諦めていたため、主プロバイダ+フォールバック先の
// 両方が同時に落ちる複合障害に対応できなかった)
function getFallbackChain(kind = 'chat') {
  const primary = getConnection(kind);
  return availableProviders()
    .filter((name) => name !== primary.provider)
    .map((name) => {
      const p = PROVIDER_DEFAULTS[name];
      return {
        provider: name,
        baseUrl: p.baseUrl,
        apiKey: apiKeyFor(name),
        model: kind === 'vision' ? p.visionModel : p.model
      };
    });
}

module.exports = { getProvider, setProvider, availableProviders, getConnection, getFallbackChain };
