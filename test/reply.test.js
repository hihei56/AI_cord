const { mockLLM } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/utils/config');
const ai = require('../src/utils/aiClient');

config.markov.enabled = false;
config.ai.twoStage.enabled = false;

const account = (extra = {}) => ({ id: 't', persona: 'テスト人格', recentReplies: [], ...extra });
const speaker = { author: { id: 'u1', username: 'bob' }, member: null };

test('相手の発言はプロンプトに1回だけ入る', async () => {
  const calls = mockLLM(() => 'それな');
  await ai.getAIResponse(account(), 'ユーザーの発言XYZ', [], null, { allowMarkovDirect: false });
  const sent = JSON.stringify(calls.at(-1).body.messages);
  assert.equal(sent.split('ユーザーの発言XYZ').length - 1, 1);
});

test('頭に付いた自分の名前・「返信:」を消す。他人の名前は消さない', async () => {
  const acc = account({ selfNames: ['特殊連鎖'] });
  for (const [out, expected] of [
    ['特殊連鎖: それは草', 'それは草'],
    ['返信：まあそうなるわな', 'まあそうなるわな'],
    ['bob: 誰それ', 'bob: 誰それ']
  ]) {
    mockLLM(() => out);
    acc.recentReplies = [];
    assert.equal(await ai.getAIResponse(acc, 'x', [], null, {}), expected);
  }
});

test('日本語のアカウントが韓国語で返したら捨てる', async () => {
  mockLLM(() => '사진만 봐도 질투다');
  assert.equal(await ai.getAIResponse(account(), '羨ましいね', [], null, {}), null);
});

test('直近で2回使った出だしは作り直しになる', async () => {
  const outs = ['は？それはないわ', 'は？！まじか', 'それはさすがにないだろ'];
  const calls = mockLLM(() => outs.shift() || 'それはさすがにないだろ');
  const acc = account({ recentReplies: ['は？', 'まあね', 'は？笑えるんだろw'] });
  assert.equal(await ai.getAIResponse(acc, 'うわめっちゃ笑える', [], null, {}), 'それはさすがにないだろ');
  assert.equal(calls.length, 3);
  assert.match(calls[0].body.messages[0].content, /使いすぎている出だし.*「は？」/);
});

test('呼ばれていない雑談はSKIPで見送れる。直接呼ばれた時はSKIPの指示を出さない', async () => {
  let calls = mockLLM(() => 'SKIP');
  assert.equal(await ai.getAIResponse(account(), '今日寒いな', [], speaker, { allowSkip: true }), null);
  assert.match(calls.at(-1).body.messages[1].content, /SKIP/);
  calls = mockLLM(() => 'それな');
  await ai.getAIResponse(account(), 'ねえ聞いてる', [], speaker, { allowSkip: false });
  assert.doesNotMatch(JSON.stringify(calls.at(-1).body.messages), /SKIP/);
});

test('長すぎる返信は文の途中ではなく区切りで切る', async () => {
  mockLLM(() => 'それはさすがに盛りすぎだろ 前も同じこと言ってて結局やらなかったじゃん 今回も口だけで終わるに一票入れとくわ どうせ三日坊主で終わるのが目に見えてる');
  const original = 'それはさすがに盛りすぎだろ 前も同じこと言ってて結局やらなかったじゃん 今回も口だけで終わるに一票入れとくわ どうせ三日坊主で終わるのが目に見えてる';
  const reply = await ai.getAIResponse(account(), '明日から筋トレする', [], speaker, {});
  assert.ok(reply.length <= config.ai.reply.maxReplyLength, `長さ: ${reply.length}`);
  assert.ok(original.startsWith(reply), '先頭から切り出している');
  assert.equal(original[reply.length], ' ', '区切り(空白)の直前で切れている');
});
