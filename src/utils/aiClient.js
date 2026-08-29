const config = require('./config');
const logger = require('./logger');
const { MarkovChain, loadCorpus, buildTokenizer } = require('./markovChain');
const { resolveDisplayName } = require('./nicknames');

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

async function callChatCompletion(messages, { temperature, maxTokens }) {
  const res = await fetch(`${config.env.aiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.env.aiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.ai.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(config.ai.reasoningEffort ? { reasoning_effort: config.ai.reasoningEffort } : {})
    })
  });
  const data = await res.json();

  if (!res.ok) {
    logger.error('AI', `HTTP ${res.status} ${res.statusText}: ${JSON.stringify(data)}`);
    return null;
  }

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    logger.error('AI', `unexpected response shape: ${JSON.stringify(data)}`);
    return null;
  }

  return content;
}

// 画像添付があった時だけ呼ぶ。普段の会話モデルとは別に、
// vision対応モデル(VISION_API_BASE_URL/VISION_API_KEY、未設定ならAI_*を使い回す)
// に投げて内容を説明させる。会話自体はテキストのみのモデルのまま。
async function describeImage(imageUrl) {
  if (!config.ai.vision?.enabled) return null;

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
              { type: 'text', text: 'この画像に何が写っているか、日本語で1〜2文で簡潔に説明して' },
              { type: 'image_url', image_url: { url: imageUrl } }
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

async function getAIResponse(accountState, userMsg, history = [], speakerMsg = null) {
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
  const draftSection = draft
    ? `\n【口調の下書き(意味は無視して口調・言い回しだけ参考にすること)】\n${draft}`
    : '';

  // speakerMsgが渡されていれば、そのユーザーの呼び名(config/nicknames.jsonの個別登録 >
  // サーバーニックネーム > username の優先順)で今の発言を表示し、AIがその名前で呼びかけられるようにする
  const speakerLabel = speakerMsg ? resolveDisplayName(speakerMsg.author, speakerMsg.member) : 'ユーザー';

  // 直近の自分の発言と同じ言い回し・同じ絵文字を連発すると露骨にbotっぽく見えるので、
  // 「これは避けて」として明示的に渡す
  const antiRepeatSection = accountState.recentReplies?.length
    ? `\n【直近の自分の発言(この言い回しや絵文字の組み合わせを繰り返さないこと)】\n${accountState.recentReplies.join('\n')}`
    : '';

  const systemPrompt = `${accountState.persona}${draftSection}${antiRepeatSection}\n【会話履歴】\n${ctx || 'なし'}\n【${speakerLabel}】\n${userMsg}\n【返信】`;

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

async function generateSelfTalk() {
  try {
    const text = await callChatCompletion(
      [
        { role: 'system', content: 'あなたは適当な人間です。深く考えずに雑談します。' },
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

module.exports = { getAIResponse, generateSelfTalk, initMarkov, describeImage };
