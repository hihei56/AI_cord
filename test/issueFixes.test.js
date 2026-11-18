const { mockLLM } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const priceApi = require('../src/utils/priceApi');
const ai = require('../src/utils/aiClient');

test('解決できない銘柄は毎回検索し直さず、間隔を空けて再試行する (issue #30)', async () => {
  let searches = 0;
  global.fetch = async () => {
    searches++;
    return { ok: true, status: 200, json: async () => ({ coins: [], pairs: [] }) };
  };
  assert.equal(await priceApi.resolveSymbol('ponz'), null);
  const first = searches;
  assert.ok(first > 0);
  assert.equal(await priceApi.resolveSymbol('ponz'), null);
  assert.equal(searches, first, '再試行の時刻までは検索しない');
  // 再試行の時刻を過ぎたら検索する。失敗が続くと間隔は倍になる
  const f = priceApi._failedResolves.get('ponz');
  f.retryAt = Date.now() - 1;
  await priceApi.resolveSymbol('ponz');
  assert.ok(searches > first);
  const g = priceApi._failedResolves.get('ponz');
  assert.equal(g.failures, 2);
  assert.ok(g.retryAt - Date.now() > 50 * 60000);
});

test('同じ絵文字で終わる発言が続いていたら、次は別の締めにさせる (issue #31)', async () => {
  const recent = ['罪なんてないんだよ 😏', 'まあね 😏', '増えてるとしか言えねぇ 😏'];
  assert.equal(ai.isTooSimilarToRecent('それはない 😏', recent), true);
  assert.equal(ai.isTooSimilarToRecent('それはない 😭', recent), false);
  assert.equal(ai.isTooSimilarToRecent('それはない 😏', recent.slice(0, 2)), false, '2回までは癖の範囲');

  const calls = mockLLM(() => 'しらんけど😭');
  require('../src/utils/config').markov.enabled = false;
  await ai.getAIResponse({ id: 'closer', persona: 'p', recentReplies: recent }, 'どう思う', [], { author: { id: 'u', username: 'u' }, member: null }, {});
  const prompt = calls.map((c) => c.body.messages.map((m) => m.content).join('\n')).join('\n');
  assert.match(prompt, /使いすぎている締めの絵文字[^\n]*😏/);
});

test('相手の言葉をなぞっただけの返信は作り直させる', async () => {
  let n = 0;
  mockLLM(() => (++n === 1 ? '白髪増えてんのか😦' : '老けたの自分のせいじゃないのに責められそう🥹'));
  require('../src/utils/config').ai.twoStage.enabled = false;
  const reply = await ai.getAIResponse({ id: 'parrot', persona: 'p', recentReplies: [] }, '近平の白髪増えたなぁ', [], { author: { id: 'u', username: 'u' }, member: null }, {});
  assert.equal(reply, '老けたの自分のせいじゃないのに責められそう🥹');
  assert.equal(ai.isParrot('白髪増えてんだろ 老いと権力の象徴か', '近平の白髪増えたなぁ'), false, '中身を足していればなぞりではない');
});

test('自律エージェントは、自分たちが既に返信した発言や古い発言には返信しない', () => {
  const { registerOwnAccount } = require('../src/utils/ownAccounts');
  registerOwnAccount('bot-a');
  const { isReplyable } = require('../src/handlers/agentHandler');
  const now = Date.now();
  const human = { id: 'h', author: { id: 'mirei', bot: false }, content: '近平の白髪増えたなぁ', createdTimestamp: now - 20 * 60000 };
  const answered = { id: 'r', author: { id: 'bot-a', bot: false }, reference: { messageId: 'h' }, createdTimestamp: now - 10 * 60000 };
  assert.equal(isReplyable(human, [human]), true);
  assert.equal(isReplyable(human, [human, answered]), false);
  assert.equal(isReplyable({ ...human, createdTimestamp: now - 90 * 60000 }, [human]), false);
});
