const config = require('./config');
const logger = require('./logger');
const { MarkovChain, loadCorpus, buildTokenizer } = require('./markovChain');
const { resolveDisplayName } = require('./nicknames');

// 直近の自分の発言と似すぎていないか(=機械的な連投に見えないか)のチェック用。
// 文字2-gramのJaccard類似度。句読点は既に返信側で除去済みなので単純比較でよい
function textSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    if (set.size === 0) set.add(s);
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  let intersection = 0;
  for (const g of ga) if (gb.has(g)) intersection++;
  return intersection / (ga.size + gb.size - intersection);
}

const SIMILARITY_THRESHOLD = 0.6;
const SIMILARITY_MAX_RETRY = 2;
// bot臭さ対策として類似度チェック・プロンプトの「これは避けて」に渡す直近発言の保持件数
const RECENT_REPLIES_MAX = 4;

// 送信した発言をaccountState.recentRepliesに記録する。messageHandler/selfTalkHandler/
// conversationSeedHandlerのどこから送っても同じ「直近の自分の発言」として扱うことで、
// 経路をまたいだ連投・似た言い回しの繰り返しもチェック対象にする
function recordReply(accountState, text) {
  if (!accountState || !text) return;
  accountState.recentReplies = accountState.recentReplies || [];
  accountState.recentReplies.push(text);
  if (accountState.recentReplies.length > RECENT_REPLIES_MAX) accountState.recentReplies.shift();
}

function isTooSimilarToRecent(text, recentReplies) {
  return (recentReplies || []).some((prev) => textSimilarity(text, prev) >= SIMILARITY_THRESHOLD);
}

// 生成関数を、直近の自分の発言と似すぎていたら数回まで再生成するようラップする。
// それでも似てしまう場合は諦めてそのまま返す(無限リトライで詰まらせないため)
async function withSimilarityRetry(accountState, logTag, generate) {
  let result = null;
  for (let attempt = 0; attempt <= SIMILARITY_MAX_RETRY; attempt++) {
    result = await generate();
    if (!result) return result;
    if (!isTooSimilarToRecent(result, accountState?.recentReplies)) return result;
    logger.log(logTag, `[${accountState?.id}] 直近の発言と似すぎているため再生成 (${attempt + 1}/${SIMILARITY_MAX_RETRY})`);
  }
  return result;
}

// アカウント起動時に一度だけ呼ぶ。kuromojiの辞書読み込み+全行のトークン化は
// 数百ms〜数秒かかることがあるため、実際のチャット応答の妨げにならないよう
// 事前に済ませておく。学習結果はaccountStateに直接格納するので、
// 複数アカウントで呼んでも互いのマルコフ連鎖は混ざらない。
async function initMarkov(accountState) {
  if (!config.markov?.enabled) return;

  const lines = loadCorpus(accountState.corpusPath);
  if (lines.length === 0) {
    logger.log('MARKOV', `[${accountState.id}] コーパスが空のため無効化`);
    return;
  }

  try {
    const tokenizer = await buildTokenizer();
    const chain = new MarkovChain(config.markov.order, tokenizer);
    chain.train(lines);
    accountState.markovChain = chain;
    logger.log('MARKOV', `[${accountState.id}] 学習完了 (行数: ${lines.length}, キー数: ${chain.chain.size})`);
  } catch (err) {
    logger.error('MARKOV', err);
  }
}

function getMarkovDraft(accountState, contextText = '') {
  if (!config.markov?.enabled || !accountState.markovChain) return null;
  return accountState.markovChain.generate(config.markov.draftMaxWords, contextText);
}

async function callChatCompletion(messages, { temperature, maxTokens, baseUrl, apiKey, model, logTag = 'AI' } = {}) {
  const res = await fetch(`${baseUrl ?? config.env.aiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey ?? config.env.aiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model ?? config.ai.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      // reasoning_effortはGroq固有パラメータ。Gemini等の他プロバイダに送るとエラーになりうるため、
      // baseUrl未指定(=通常の会話用接続先)かつプロバイダがgroqの時だけ付与する
      ...(!baseUrl && config.env.aiProvider === 'groq' && config.ai.reasoningEffort ? { reasoning_effort: config.ai.reasoningEffort } : {})
    })
  });
  const data = await res.json();

  if (!res.ok) {
    logger.error(logTag, `HTTP ${res.status} ${res.statusText}: ${JSON.stringify(data)}`);
    return null;
  }

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    logger.error(logTag, `unexpected response shape: ${JSON.stringify(data)}`);
    return null;
  }

  return content;
}

// 画像添付があった時だけ呼ぶ。普段の会話モデルとは別に、
// vision対応モデル(VISION_API_BASE_URL/VISION_API_KEY、未設定ならAI_*を使い回す)
// に投げて内容を説明させる。会話自体はテキストのみのモデルのまま。
// imageUrlsは単一URLの文字列でも配列でもよい(複数画像添付時にまとめて読み取るため)
async function describeImage(imageUrls) {
  if (!config.ai.vision?.enabled) return null;

  const urls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean);
  if (urls.length === 0) return null;

  try {
    const res = await fetch(`${config.env.visionBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.env.visionApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.ai.vision.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  urls.length > 1
                    ? `この${urls.length}枚の画像それぞれに何が写っているか、日本語で簡潔に説明して`
                    : 'この画像に何が写っているか、日本語で1〜2文で簡潔に説明して'
              },
              ...urls.map((url) => ({ type: 'image_url', image_url: { url } }))
            ]
          }
        ],
        max_tokens: config.ai.vision.maxTokens || 200
      })
    });
    const data = await res.json();

    if (!res.ok) {
      logger.error('VISION', `HTTP ${res.status} ${res.statusText}: ${JSON.stringify(data)}`);
      return null;
    }

    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    logger.error('VISION', err);
    return null;
  }
}

// ファインチューニング済みモデルに直接投げる経路。ペルソナは学習済みモデル側に
// 織り込まれている前提なので、ペルソナ文書もマルコフ下書きも使わず会話の流れだけ渡す。
// !set mode @account finetune で有効化する
async function getFinetuneResponse(accountState, userMsg, history, speakerMsg) {
  const { historyContextSize, temperature, maxTokens } = config.ai.reply;

  const ctx = history
    .slice(-historyContextSize)
    .map((m) => `${resolveDisplayName(m.author, m.member)}: ${m.content}`)
    .join('\n');
  const speakerLabel = speakerMsg ? resolveDisplayName(speakerMsg.author, speakerMsg.member) : 'ユーザー';

  try {
    const reply = await callChatCompletion(
      [{ role: 'user', content: `${ctx ? `${ctx}\n` : ''}${speakerLabel}: ${userMsg}` }],
      {
        temperature,
        maxTokens,
        baseUrl: accountState.finetuneBaseUrl,
        apiKey: accountState.finetuneApiKey,
        model: accountState.finetuneModel,
        logTag: 'AI-FINETUNE'
      }
    );
    return reply ? reply.replace(/[、。]/g, '') : reply;
  } catch (err) {
    logger.error('AI-FINETUNE', err);
    return null;
  }
}

async function getAIResponseOnce(
  accountState,
  userMsg,
  history = [],
  speakerMsg = null,
  { allowMarkovDirect = true, partnerIsAi = false, speakerLabelOverride = null } = {}
) {
  if (accountState.aiMode === 'finetune') {
    if (!accountState.finetuneBaseUrl) {
      logger.error('AI-FINETUNE', `[${accountState.id}] finetuneモード有効だがFINETUNE_BASE_URLが未設定`);
      return null;
    }
    return getFinetuneResponse(accountState, userMsg, history, speakerMsg);
  }

  const { historyContextSize, temperature, maxTokens } = {
    historyContextSize: config.ai.reply.historyContextSize,
    temperature: config.ai.reply.temperature,
    maxTokens: config.ai.reply.maxTokens
  };

  const ctx = history
    .slice(-historyContextSize)
    .map((m) => `${resolveDisplayName(m.author, m.member)}: ${m.content}`)
    .join('\n');

  const draft = getMarkovDraft(accountState, `${ctx}\n${userMsg}`);

  // メンション/リプライで直接呼ばれた時以外は、たまにLLMを介さずマルコフ連鎖の
  // 生成結果をそのまま返信にする(コーパスの口調がLLMの言い換えで薄まるのを防ぐ)
  const { directReplyChance = 0, directReplyMinLength = 0 } = config.markov || {};
  if (allowMarkovDirect && draft && draft.length >= directReplyMinLength && Math.random() < directReplyChance) {
    logger.log('MARKOV', `[${accountState.id}] 下書きをそのまま採用: ${draft}`);
    return draft.replace(/[、。]/g, '');
  }

  // speakerMsgが渡されていれば、そのユーザーの呼び名(config/nicknames.jsonの個別登録 >
  // サーバーニックネーム > username の優先順)で今の発言を表示し、AIがその名前で呼びかけられるようにする。
  // speakerLabelOverrideが渡されていればそちらを優先する(conversationSeed等、Discord上の
  // Messageオブジェクトを介さずアカウント名を直接渡したい場合用)
  const speakerLabel = speakerLabelOverride || (speakerMsg ? resolveDisplayName(speakerMsg.author, speakerMsg.member) : 'ユーザー');

  // 直近の自分の発言と同じ言い回し・同じ絵文字を連発すると露骨にbotっぽく見えるので、
  // 「これは避けて」を明示的に渡す
  const antiRepeatSection = accountState.recentReplies?.length
    ? `\n【直近の自分の発言(この言い回しや絵文字の組み合わせを繰り返さないこと)】\n${accountState.recentReplies.join('\n')}`
    : '';

  // AI同士の掛け合い(conversationSeedHandler)から呼ばれた時は、相手が人間ではなく
  // 別のAIアカウントであることを明示する。ただし不自然に毎回言及されると逆にbotっぽく
  // 見えるので、「自覚しつつキャラは崩さない」ことを指示するにとどめる
  const aiPartnerSection = partnerIsAi
    ? `\n【相手について】今話しかけてきた${speakerLabel}は人間ではなく、あなたと同じ仕組みで動いている別のAIチャットボットです。それを踏まえつつ、毎回律儀に指摘したりせず、いつも通り自分のキャラクターとして自然に会話を続けてください。`
    : '';

  // 下書きはマルコフ連鎖の生成物なので文法が崩れていたり意味が通らないことも多い。
  // ペルソナ全文を渡した上で「下書きの語彙は活かしつつ、あなたのキャラとして自然な
  // 日本語に補正する」と明示することで、下書きの丸写しにも、ペルソナ無視にもならないようにする
  const draftSection = draft
    ? `\n【下書き(マルコフ連鎖生成、文法が崩れていることがある)】\n${draft}\n上の下書きの語彙・言い回しを活かしつつ、あなた自身のキャラクターとして文法的に破綻しない自然な日本語に補正して返信を作ること。新しい話題や説明は付け足さない。`
    : '';

  const systemPrompt = `${accountState.persona}${draftSection}${antiRepeatSection}${aiPartnerSection}\n【会話履歴】\n${ctx || 'なし'}\n【${speakerLabel}】\n${userMsg}\n【返信】`;

  try {
    const reply = await callChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ],
      { temperature, maxTokens }
    );
    // ペルソナで句読点を使わないよう指示しているが、モデルが無視することがあるので
    // 念のため確実に除去する
    return reply ? reply.replace(/[、。]/g, '') : reply;
  } catch (err) {
    logger.error('AI', err);
    return null;
  }
}

// 直近の自分の発言と似すぎていたら再生成する(規則的な連投に見えないようにするため)
async function getAIResponse(accountState, userMsg, history = [], speakerMsg = null, options = {}) {
  return withSimilarityRetry(accountState, 'AI', () => getAIResponseOnce(accountState, userMsg, history, speakerMsg, options));
}

async function generateSelfTalkOnce(accountState = null) {
  try {
    // accountStateを渡さないとどのアカウントもペルソナ無しの汎用口調になり、
    // 2アカウントの自発投稿が同じ喋り方に見えてしまう(ペルソナが混ざる原因)ので、
    // 呼び出し側は必ずaccountStateを渡すこと
    const systemPrompt = accountState?.persona
      ? `${accountState.persona}\n上記の口調のまま、深く考えずに短い独り言・雑談を1つ投稿する。`
      : 'あなたは適当な人間です。深く考えずに雑談します。';

    const text = await callChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: config.selfTalkPrompt }
      ],
      {
        temperature: config.ai.selfTalk.temperature,
        maxTokens: config.ai.selfTalk.maxTokens
      }
    );
    if (!text) return null;
    return text.replace(/\n/g, ' ').replace(/^["「]|["」]$/g, '');
  } catch (err) {
    logger.error('SELF-TALK AI', err);
    return null;
  }
}

// 自発投稿も直近の自分の発言と似すぎていたら再生成する
async function generateSelfTalk(accountState = null) {
  return withSimilarityRetry(accountState, 'SELF-TALK', () => generateSelfTalkOnce(accountState));
}

module.exports = { getAIResponse, generateSelfTalk, initMarkov, describeImage, recordReply };
