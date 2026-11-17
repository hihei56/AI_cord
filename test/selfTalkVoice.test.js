const { mockLLM } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/utils/config');
const ai = require('../src/utils/aiClient');

test('句読点の無い長文は、文字数ちょうどではなく話し言葉の区切りで切る', () => {
  const out = ai.toSingleLine('先週のコンビニで買ったチョコレート急に溶けてパッケージがべちゃべちゃになってたんだけどこれって円安で仕入れコスト上がってるってことなのかな');
  assert.equal(out, '先週のコンビニで買ったチョコレート急に溶けてパッケージがべちゃべちゃになってたんだけど');
});

test('自発投稿でも人格の口調(絵文字)を消さず、自分の直近の発言を口調の手本として渡す', async () => {
  config.markov.enabled = false;
  const calls = mockLLM(() => '円安えぐ😔');
  const state = { id: 'voice', persona: '文末に絵文字(😔)をつける', recentReplies: ['まあ別に😔', 'それな✨'] };
  await ai.generateSelfTalk(state, '円安で輸入品が上がる話', 'center');
  const sys = calls[0].body.messages[0].content;
  const user = calls[0].body.messages[1].content;
  assert.doesNotMatch(user, /絵文字と句読点は使わない/, '人格の絵文字を一律に禁止しない');
  assert.match(sys, /あなたの直近の発言[\s\S]*まあ別に😔/);
  assert.match(user, /体験談は作らない/);
  assert.match(user, /人格設定のいつもの口調/);
  assert.doesNotMatch(sys, /自分のエピソードを振って/);
});
