const config = require('./config');
const logger = require('./logger');

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
      max_tokens: maxTokens
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
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

  const systemPrompt = `${config.persona}\n【会話履歴】\n${ctx || 'なし'}\n【ユーザー】\n${userMsg}\n【返信】`;

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

module.exports = { getAIResponse, generateSelfTalk };
