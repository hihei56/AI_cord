const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { MarkovChain, loadCorpus, buildTokenizer } = require('./markovChain');
const { resolveDisplayName } = require('./nicknames');
const aiProvider = require('./aiProvider');
const { formatNowJST } = require('./datetime');
const { getRandomHeadline } = require('./newsTopics');

// 「1行に収める」をプロンプト指示だけに頼らず、コード側で強制的に成形する。
// 複数行に分かれていたら最初の1行だけを採用する(残りを繋げると逆に長くなるため
// 意味が無い)。さらに文字数上限を超えていたら切り詰める
function toSingleLine(text) {
  const maxLength = config.ai?.reply?.maxReplyLength || 60;
  const firstLine = text.split('\n')[0].replace(/[、。]/g, '').trim();
  return firstLine.length > maxLength ? firstLine.slice(0, maxLength) : firstLine;
}

// モデル側のチャットテンプレート制御トークンがそのまま応答本文に漏れてくることがある
// (NVIDIA NIMのllama系モデル等で確認済み。例: "<|start_header_id|>assistant<|end_header_id|>")。
// これが混ざった応答は文章として壊れているため、そのまま投稿せず失敗扱いにして
// フォールバックチェーンの次のプロバイダに回す
const RAW_TEMPLATE_TOKEN_RE = /<\|(?:start|end)_header_id\|>|<\|eot_id\|>|<\|im_(?:start|end)\|>/;

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

  // 「ファイルが見つからない(CORPUS_FILE[_N]のファイル名の誤字・拡張子の有無・
  // 大文字小文字の不一致など)」と「ファイルはあるが中身が空」を区別してログに出す。
  // 前者を"コーパスが空"とだけ表示すると設定ミスに気付きにくいため
  if (!fs.existsSync(accountState.corpusPath)) {
    let available = [];
    try {
      available = fs.readdirSync(path.dirname(accountState.corpusPath));
    } catch {
      // ignore
    }
    logger.error(
      'MARKOV',
      `[${accountState.id}] コーパスファイルが見つかりません: ${accountState.corpusPath}\n` +
        `  config/corpus/ 内の候補(大文字小文字も一致させること): ${available.join(', ') || '(取得失敗)'}`
    );
    return;
  }

  const lines = loadCorpus(accountState.corpusPath);
  if (lines.length === 0) {
    logger.log('MARKOV', `[${accountState.id}] コーパスファイルの中身が空(または改行のみ)のため無効化: ${accountState.corpusPath}`);
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

// 1回分のchat completionsリクエストを送る薄いラッパー。成功/失敗を例外ではなく
// 戻り値で表現し、呼び出し側(callChatCompletion)でフォールバック判断に使う
async function requestChatCompletion(conn, messages, { temperature, maxTokens, logTag }) {
  const res = await fetch(`${conn.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${conn.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: conn.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      // reasoning_effortはGroqのreasoningモデル(gpt-oss等)専用パラメータ。Gemini等の
      // 他プロバイダや、Groqでもllama-3.1-8b-instantのような非reasoningモデルに送ると
      // エラーになりうるため、プロバイダがgroqかつモデル名に'gpt-oss'を含む時だけ付与する
      ...(conn.provider === 'groq' && conn.model?.includes('gpt-oss') && config.ai.reasoningEffort
        ? { reasoning_effort: config.ai.reasoningEffort }
        : {})
    })
  });
  const data = await res.json();

  if (!res.ok) {
    logger.error(logTag, `HTTP ${res.status} ${res.statusText} (${conn.provider}): ${JSON.stringify(data)}`);
    return null;
  }

  // 実際の消費トークン数をログに残す。レート制限の間隔調整を勘ではなく
  // 実測値ベースでできるようにするため(以前は成功時の消費量が全く見えなかった)
  if (data.usage) {
    logger.log(logTag, `[usage/${conn.provider}] prompt=${data.usage.prompt_tokens} completion=${data.usage.completion_tokens} total=${data.usage.total_tokens}`);
  }

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    logger.error(logTag, `unexpected response shape (${conn.provider}): ${JSON.stringify(data)}`);
    return null;
  }

  if (RAW_TEMPLATE_TOKEN_RE.test(content)) {
    logger.error(logTag, `チャットテンプレート制御トークンが漏れた壊れた応答のため破棄 (${conn.provider}): ${content}`);
    return null;
  }

  return content;
}

async function callChatCompletion(messages, { temperature, maxTokens, baseUrl, apiKey, model, logTag = 'AI', kind = 'chat' } = {}) {
  // baseUrl/apiKey/modelが明示指定されていなければ、aiProviderで現在選択中の
  // プロバイダ(!providerコマンドでランタイムに切り替え可能)から接続情報を取る。
  // kind='seed'(AI同士の掛け合い)は人間向けの通常会話とは別のトークン枠(Gemini等)を使う。
  // baseUrl未指定でmodelだけ指定された場合(アカウント単位のCHAT_MODEL上書き)は、
  // プロバイダの認証・接続先はそのままにモデル名だけ差し替える
  const conn = baseUrl
    ? { provider: null, baseUrl, apiKey, model }
    : { ...aiProvider.getConnection(kind), ...(model ? { model } : {}) };

  const content = await requestChatCompletion(conn, messages, { temperature, maxTokens, logTag });
  if (content) return content;

  // baseUrlが明示指定されている(finetune等の専用接続先)場合はフォールバック対象外。
  // それ以外はレート制限・404等の失敗時、APIキーが設定済みの他プロバイダを順番に
  // 全部試す(1つ試して失敗したら諦める、ではなく残り全プロバイダを使い切るまで
  // リトライする。主プロバイダとフォールバック先が同時に落ちる複合障害でも
  // 3つ目・4つ目のプロバイダが生きていれば会話を止めないため)
  if (baseUrl) return null;

  for (const fallback of aiProvider.getFallbackChain(kind)) {
    logger.log(logTag, `${conn.provider}が失敗したため${fallback.provider}にフォールバック`);
    const fallbackContent = await requestChatCompletion(fallback, messages, { temperature, maxTokens, logTag });
    if (fallbackContent) return fallbackContent;
  }

  return null;
}

// 画像添付があった時だけ呼ぶ。普段の会話モデルとは別に、
// vision対応モデル(VISION_API_BASE_URL/VISION_API_KEY、未設定ならAI_*を使い回す)
// に投げて内容を説明させる。会話自体はテキストのみのモデルのまま。
// imageUrlsは単一URLの文字列でも配列でもよい(複数画像添付時にまとめて読み取るため)
async function describeImage(imageUrls) {
  if (!config.ai.vision?.enabled) return null;

  const urls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean);
  if (urls.length === 0) return null;

  const conn = aiProvider.getConnection('vision');

  try {
    const res = await fetch(`${conn.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conn.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: conn.model,
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
    return reply ? toSingleLine(reply) : reply;
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
  { allowMarkovDirect = true, partnerIsAi = false, speakerLabelOverride = null, topicHint = null } = {}
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

  // 下書きが実際に生成されてプロンプトに渡っているかどうかを、直接採用しなかった
  // 場合(=LLM補正パスに回る大半のケース)でも検証できるようにログを残す。
  // 従来は直接採用時にしかログが出ず、「マルコフが使われているか」を外から確認できなかった
  if (draft) {
    logger.log('MARKOV', `[${accountState.id}] 下書き生成: ${draft}`);
  } else if (config.markov?.enabled && accountState.markovChain) {
    logger.log('MARKOV', `[${accountState.id}] 下書き生成失敗(生成結果が空)`);
  }

  // メンション/リプライで直接呼ばれた時以外は、たまにLLMを介さずマルコフ連鎖の
  // 生成結果をそのまま返信にする(コーパスの口調がLLMの言い換えで薄まるのを防ぐ)
  const { directReplyChance = 0, directReplyMinLength = 0 } = config.markov || {};
  if (allowMarkovDirect && draft && draft.length >= directReplyMinLength && Math.random() < directReplyChance) {
    logger.log('MARKOV', `[${accountState.id}] 下書きをそのまま採用: ${draft}`);
    return toSingleLine(draft);
  }

  // speakerMsgが渡されていれば、そのユーザーの呼び名(config/nicknames.jsonの個別登録 >
  // サーバーニックネーム > username の優先順)で今の発言を表示し、AIがその名前で呼びかけられるようにする。
  // speakerLabelOverrideが渡されていればそちらを優先する(conversationSeed等、Discord上の
  // Messageオブジェクトを介さずアカウント名を直接渡したい場合用)
  const speakerLabel = speakerLabelOverride || (speakerMsg ? resolveDisplayName(speakerMsg.author, speakerMsg.member) : 'ユーザー');

  // 長期記憶: このユーザーについて過去に覚えたこと(memoryStore、要約済みなら特徴メモ、
  // 未要約ならやり取りの断片)があればプロンプトに含める。「前も話したよね」のような
  // 一貫した関係性を持たせるため
  const speakerNotes = speakerMsg?.author?.id ? accountState.memoryStore?.getUserNotes(speakerMsg.author.id) : null;
  const memorySection = speakerNotes?.length
    ? `\n【${speakerLabel}について覚えていること】\n${speakerNotes.join('\n')}`
    : '';

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

  // 何度か「下書きに厳密に従わせる」⇄「下書きを軽視させる」を行き来した末、
  // 人格ありアカウントは下書きを軽い参考程度に格下げし、人格に従って自然に
  // 喋らせる方針に落ち着いた。下書きの単語をそのまま使う義務は無く、会話の
  // 流れに自然に応じてよい(それこそが本来自然な会話であるため)。人格の口調・
  // キャラクターを保つことだけを最優先にする
  const draftSection =
    draft && accountState.persona
      ? `\n【下書き(マルコフ連鎖生成、話題やニュアンスの軽い参考程度)】\n${draft}\nこの下書きはあくまで軽い参考であり、単語をそのまま使う必要は無い。会話の流れに自然に応じつつ、必ず自分の人格設定の口調・キャラクターで喋ること。`
      : draft
        ? `\n【下書き(マルコフ連鎖生成)】\n${draft}\n人格設定は無いので、上の下書きをベースに最低限の誤字脱字・助詞の修正だけを行って返信すること。単語の言い換え、文の作り直し、新しい話題や説明の追加はしないこと。下書きに無い一人称や主語を勝手に補わないこと。Discordの実際のユーザーの発言のように、丁寧な完全文に整えず、素っ気なく短いままにすること。`
        : '';

  // 人格プロンプトも下書きも無い(PERSONA未設定かつマルコフ下書きも無い)場合、
  // LLMへの指示が実質ゼロになり、丁寧で説明的な「アシスタントらしい」文章を
  // 自由に書いてしまいがち(「AIによる修正が過剰」に見える一因)。最低限、
  // Discordの雑談らしい素っ気なさだけは指定しておく
  const noGuidanceFallback =
    !accountState.persona && !draft
      ? '\n特定の人格設定はありません。Discordの雑談らしく素っ気なく短く返信すること。丁寧なアシスタント口調・説明的な言い回し・絵文字の多用はしないこと。'
      : '';

  // 人格プロンプト側に「2〜4行まで」等の指示があっても、これを優先して1行に収めさせる。
  // Discordの通常の雑談は長文より短文連投の方が自然で、複数行は機械的・説明的に見えやすい
  const lengthConstraint = '\n【重要】返信は必ず1行に収めること。改行して2行以上にしたり、長々と説明したりしない。';

  // 計算問題や込み入った処理に一瞬で完璧な答えを返すと、いかにもAIっぽく見えて
  // 不自然(人間はそんなに速く正確に暗算できない)。特に計算問題はわざと間違えたり、
  // 自信なさげに答えるくらいがちょうどいい
  const humanLikeConstraint =
    '\n【重要】計算問題や込み入った処理を人間離れした速さ・正確さで解かない。特に計算問題は暗算のふりをして、わざと間違えるか「合ってるか自信ない」くらいの態度で答えること。';

  // 日付・曜日・時刻を伝えておくことで、「今日」「週末」「もう夜だし」のような
  // 時間感覚のある発言ができるようにする(これが無いとAIは常に日付不明のまま喋る)
  const dateSection = `\n【現在日時】${formatNowJST()}`;

  // AI同士の掛け合いでは、会話開始前にplanConversationTopicで決めたお題を
  // 全ターンで共有する。行き当たりばったりで各ターンを生成すると「そうだね」の
  // 連発のような浅い応酬になりがちなので、会話全体を貫く軸を持たせる
  const topicSection = topicHint ? `\n【この会話のお題(参考程度)】${topicHint}` : '';

  const systemPrompt = `${accountState.persona}${memorySection}${noGuidanceFallback}${antiRepeatSection}${aiPartnerSection}${lengthConstraint}${humanLikeConstraint}${dateSection}${topicSection}${draftSection}\n【会話履歴】\n${ctx || 'なし'}\n【${speakerLabel}】\n${userMsg}\n【返信】`;

  try {
    const reply = await callChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ],
      // AI同士の掛け合い(partnerIsAi)はkind: 'seed'で区別する。プロバイダ振り分けは
      // aiProvider側の設定に従う。modelはアカウント単位のCHAT_MODEL上書きがあれば
      // それを使う(未設定ならプロバイダの既定モデルのまま)
      { temperature, maxTokens, kind: partnerIsAi ? 'seed' : 'chat', model: accountState.chatModel }
    );
    if (reply) return toSingleLine(reply);

    // LLM呼び出し失敗時(レート制限429など)に生の下書きをそのまま返信にしていたが、
    // 人格の口調が全く反映されない不自然な発言になり不評だったため撤回。
    // 失敗した時は黙って次の機会を待つ(完全に無反応になるのは他の対策で軽減する)
    return null;
  } catch (err) {
    logger.error('AI', err);
    return null;
  }
}

// 直近の自分の発言と似すぎていたら再生成する(規則的な連投に見えないようにするため)
async function getAIResponse(accountState, userMsg, history = [], speakerMsg = null, options = {}) {
  return withSimilarityRetry(accountState, 'AI', () => getAIResponseOnce(accountState, userMsg, history, speakerMsg, options));
}

async function generateSelfTalkOnce(accountState = null, topicHint = null) {
  try {
    // accountStateを渡さないとどのアカウントもペルソナ無しの汎用口調になり、
    // 2アカウントの自発投稿が同じ喋り方に見えてしまう(ペルソナが混ざる原因)ので、
    // 呼び出し側は必ずaccountStateを渡すこと
    const dateLine = `\n【現在日時】${formatNowJST()}`;

    // topicHint(planConversationTopicで事前に決めたお題)があればそれを優先し、
    // 無い場合のみ一定確率で実際のニュース見出しを話題のきっかけとして渡す。
    // 丸ごと読み上げたり生真面目に解説されると不自然なので、あくまで着想程度に
    // 留めるよう明示する
    let newsLine = topicHint ? `\n【会話のお題(参考程度)】${topicHint}` : '';
    if (!topicHint && Math.random() < (config.ai.selfTalk.newsTopicChance ?? 0)) {
      const headline = await getRandomHeadline();
      if (headline) {
        newsLine = `\n【最近のニュース見出し(参考程度。丸ごと引用したり生真面目に解説したりしない)】${headline}`;
      }
    }

    const systemPrompt = accountState?.persona
      ? `${accountState.persona}${dateLine}${newsLine}\n上記の口調のまま、深く考えずに短い独り言・雑談を1つ投稿する。`
      : `あなたは適当な人間です。深く考えずに雑談します。${dateLine}${newsLine}`;

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
async function generateSelfTalk(accountState = null, topicHint = null) {
  return withSimilarityRetry(accountState, 'SELF-TALK', () => generateSelfTalkOnce(accountState, topicHint));
}

// AI同士の掛け合いを始める前に、賢いモデルで一度「今回何を話すか」を考えさせる。
// 各ターンをその場しのぎで生成すると「そうだね」の連発のような浅い応酬になりがちなので、
// 会話全体を貫く簡単なお題を先に決めておき、両アカウントの発言生成に共有する。
// 失敗してもnullを返すだけで、呼び出し側は従来通り(お題無し)で進行できる
async function planConversationTopic(personaA, personaB) {
  try {
    const dateLine = `【現在日時】${formatNowJST()}`;
    const headline = await getRandomHeadline();
    const newsLine = headline ? `\n【最近のニュース見出し】${headline}` : '';

    const prompt =
      `${dateLine}${newsLine}\n【キャラクター1の人格】${personaA || '(人格設定なし)'}\n【キャラクター2の人格】${personaB || '(人格設定なし)'}\n\n` +
      'この2人がDiscordで交わす短い雑談のお題を1つだけ提案してください。日時やニュースを参考にしても、2人の人格に合いそうな全く別の話題でも構いません。' +
      '説明・前置き・理由は書かず、お題そのものだけを15文字以内の名詞句かフレーズで出力すること。';

    const topic = await callChatCompletion([{ role: 'user', content: prompt }], {
      temperature: 0.9,
      maxTokens: 60,
      logTag: 'SEED-PLAN'
    });
    if (!topic) return null;
    return topic.replace(/\n/g, ' ').replace(/^["「【]|["」】]$/g, '').trim().slice(0, 40) || null;
  } catch (err) {
    logger.error('SEED-PLAN', err);
    return null;
  }
}

// 長期記憶: 1往復のやり取りを生ログとしてmemoryStoreに追記する。
// 圧縮(要約)前提の断片なので長々と保存せず要点だけの短い1行にする
function recordMemory(accountState, userId, speakerLabel, userMsg, reply) {
  if (!accountState.memoryStore || !userId) return;
  const fragment = `${speakerLabel}「${userMsg.slice(0, 40)}」→ 自分「${reply.slice(0, 40)}」`;
  accountState.memoryStore.addUserNote(userId, fragment);
}

// ユーザーごとの生ログがMAX_RAW_NOTES件溜まったら、LLMに1回投げて特徴・好み・
// 口癖などの短い箇条書きメモに圧縮する(そのまま溜め続けると肥大化するうえ、
// プロンプトに生ログを流し込んでも読みにくいだけなので)。呼び出し側でawaitせず
// バックグラウンドで実行して返信を遅らせないようにする想定
async function compressUserMemoryIfNeeded(accountState, userId, displayName) {
  if (!accountState.memoryStore?.shouldCompress(userId)) return;

  const notes = accountState.memoryStore.getUserNotes(userId);
  const prompt =
    `以下は${displayName}という人物とのこれまでのやり取りの断片的な記録です。\n${notes.join('\n')}\n` +
    `この記録から読み取れる${displayName}の特徴・好み・口癖・よく話す話題だけを、日本語で3行以内の` +
    '簡潔な箇条書きメモにまとめてください。記録から読み取れないことは書かないこと。';

  try {
    const summary = await callChatCompletion([{ role: 'user', content: prompt }], {
      temperature: 0.3,
      maxTokens: 150,
      logTag: 'MEMORY'
    });
    if (!summary) return;
    const lines = summary.split('\n').map((l) => l.trim()).filter(Boolean);
    accountState.memoryStore.setSummarizedNotes(userId, lines);
    logger.log('MEMORY', `[${accountState.id}] ${displayName}の記憶を要約: ${lines.join(' / ')}`);
  } catch (err) {
    logger.error('MEMORY', err);
  }
}

module.exports = {
  getAIResponse,
  generateSelfTalk,
  planConversationTopic,
  initMarkov,
  describeImage,
  recordReply,
  recordMemory,
  compressUserMemoryIfNeeded
};
