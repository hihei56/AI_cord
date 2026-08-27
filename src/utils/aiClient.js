const config = require('./config');
const logger = require('./logger');
const { MarkovChain, loadCorpus, buildTokenizer } = require('./markovChain');

let markovChain = null;

// bot起動時に一度だけ呼ぶ。kuromojiの辞書読み込み+全行のトークン化は
// 数百ms〜数秒かかることがあるため、実際のチャット応答の妨げにならないよう
// 事前に済ませておく。
async function initMarkov() {
  if (!config.markov?.enabled) return;

  const lines = loadCorpus(config.corpusPath);
  if (lines.length === 0) {
    logger.log('MARKOV', 'コーパスが空のため無効化');
    return;
  }

  try {
    const tokenizer = await buildTokenizer();
    markovChain = new MarkovChain(config.markov.order, tokenizer);
    markovChain.train(lines);
    logger.log('MARKOV', `学習完了 (行数: ${lines.length}, キー数: ${markovChain.chain.size})`);
  } catch (err) {
    logger.error('MARKOV', err);
  }
}

function getMarkovDraft(contextText = '') {
  if (!config.markov?.enabled || !markovChain) return null;
  return markovChain.generate(config.markov.draftMaxWords, contextText);
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

async function getAIResponse(userMsg, history = []) {
  const { historyContextSize, temperature, maxTokens } = {
    historyContextSize: config.ai.reply.historyContextSize,
    temperature: config.ai.reply.temperature,
    maxTokens: config.ai.reply.maxTokens
  };

  const ctx = history
    .slice(-historyContextSize)
    .map((m) => `${m.author.username}: ${m.content}`)
    .join('\n');

  const draft = getMarkovDraft(`${ctx}\n${userMsg}`);
  const draftSection = draft
    ? `\n【口調の下書き(意味は無視して口調・言い回しだけ参考にすること)】\n${draft}`
    : '';

  const systemPrompt = `${config.persona}${draftSection}\n【会話履歴】\n${ctx || 'なし'}\n【ユーザー】\n${userMsg}\n【返信】`;

  try {
    return await callChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ],
      { temperature, maxTokens }
    );
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

module.exports = { getAIResponse, generateSelfTalk, initMarkov };
