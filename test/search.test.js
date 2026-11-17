require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/utils/config');
const webSearch = require('../src/utils/webSearch');
const ai = require('../src/utils/aiClient');

// LLMとTavilyの両方を差し替える。llm(systemPrompt, userPrompt, n) が返す文がLLMの応答になる
function mockAll(llm, searchAnswer = 'モンハンワイルズ2は2027年3月発売予定') {
  const calls = { llm: [], search: [] };
  global.fetch = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    if (String(url).includes('tavily')) {
      calls.search.push(body.query);
      return { ok: true, status: 200, json: async () => ({ answer: searchAnswer, results: [] }) };
    }
    calls.llm.push(body);
    const content = llm(body.messages[0].content, body.messages[1]?.content, calls.llm.length);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return calls;
}

const state = () => ({ id: 'search-test', persona: 'p', recentReplies: [] });
const speaker = { author: { id: 'u1', username: 'bob' }, member: null };

test.beforeEach(() => {
  process.env.TAVILY_API_KEY = 'dummy';
  webSearch._cache.clear();
  config.markov.enabled = false;
  config.ai.twoStage.enabled = true;
  config.ai.twoStage.search = true;
});
test.after(() => delete process.env.TAVILY_API_KEY);

test('考える役が「知らない」と判断した時だけ検索し、結果を踏まえて考え直して返信に使う', async () => {
  const calls = mockAll((sys, user, n) => {
    if (sys.includes('頭の中')) return sys.includes('さっき調べて分かったこと') ? '来年3月に出るらしいと答える' : '検索: モンハンワイルズ2 発売日';
    return '来年の3月らしいよ';
  });
  const reply = await ai.getAIResponse(state(), 'モンハンワイルズ2っていつ出るの？', [], speaker, { direct: true });
  assert.equal(reply, '来年の3月らしいよ');
  assert.deepEqual(calls.search, ['モンハンワイルズ2 発売日']);
  const writer = calls.llm.at(-1).messages[0].content;
  assert.match(writer, /さっき調べて分かったこと[\s\S]*2027年3月/);
  assert.match(writer, /言う内容[\s\S]*来年3月に出るらしい/);
  assert.doesNotMatch(writer, /検索:/, '検索の指示が書く役に漏れない');
});

test('考える役が検索不要と判断したら検索しない', async () => {
  const calls = mockAll((sys) => (sys.includes('頭の中') ? 'お疲れと労う' : 'おつ〜'));
  await ai.getAIResponse(state(), '今日バイト疲れたわ', [], speaker, { direct: true });
  assert.equal(calls.search.length, 0);
});

test('キーが無い・設定でオフの時は、考える役に検索の選択肢自体を出さない', async () => {
  for (const setup of [() => delete process.env.TAVILY_API_KEY, () => (config.ai.twoStage.search = false)]) {
    setup();
    const calls = mockAll((sys) => (sys.includes('頭の中') ? '知らないと言う' : 'しらん'));
    await ai.getAIResponse(state(), 'モンハンワイルズ2っていつ出るの？', [], speaker, { direct: true });
    assert.doesNotMatch(calls.llm[0].messages[0].content, /検索: 調べる語句/);
    assert.equal(calls.search.length, 0);
    process.env.TAVILY_API_KEY = 'dummy';
    config.ai.twoStage.search = true;
  }
});

test('同じ語句の検索は使い回して無料枠を節約する', async () => {
  const calls = mockAll((sys) => (sys.includes('頭の中') ? (sys.includes('さっき調べて') ? '答える' : '検索: モンハンワイルズ2 発売日') : 'らしいよ'));
  await ai.getAIResponse(state(), 'ワイルズ2いつ？', [], speaker, { direct: true });
  await ai.getAIResponse(state(), 'ワイルズ2って発売いつだっけ', [], speaker, { direct: true });
  assert.equal(calls.search.length, 1);
});

test('調べても分からなかった時は、作り話をしないよう考える役に伝える', async () => {
  const prompts = [];
  global.fetch = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    if (String(url).includes('tavily')) return { ok: true, status: 200, json: async () => ({ answer: null, results: [] }) };
    prompts.push(body.messages[0].content);
    const content = body.messages[0].content.includes('頭の中') ? (prompts.length === 1 ? '検索: 謎のゲーム' : '知らないと言う') : 'しらんな';
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  await ai.getAIResponse(state(), '謎のゲームって知ってる？', [], speaker, { direct: true });
  assert.match(prompts[1], /調べても分からなかった/);
});
