const { mockLLM } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const config = require('../src/utils/config');
const ai = require('../src/utils/aiClient');

const corpusPath = path.join(__dirname, '..', 'config', 'corpus', 'suisui.txt');
const own = ['え！おれもコンビニバイトクビなったことある', 'しげおに捨てられた', 'やっす', '今から寝まつ'];

test('本人のコーパスは「自分の過去の発言」として見せ、直近のbotの発言は繰り返し防止にだけ使う', async () => {
  config.markov.enabled = false;
  config.ai.twoStage.enabled = false;
  const calls = mockLLM(() => 'え！それおれもやった');
  const state = { id: 'sv', persona: 'p', recentReplies: ['うんざりだ'], corpusPath, corpusLines: own };
  assert.equal(ai.isSelfVoice(state), true);
  await ai.getAIResponse(state, 'コンビニのバイトやめた', [], { author: { id: 'u', username: 'u' }, member: null }, {});
  const sys = calls.at(-1).body.messages[0].content;
  assert.match(sys, /あなた自身の過去の発言\(本物。これがあなたの喋り方\)[\s\S]*しげおに捨てられた/);
  assert.doesNotMatch(sys, /例の人たちの口癖を混ぜない/, '本人の発言を「他人の口癖」扱いしない');
  assert.doesNotMatch(sys, /あなたの直近の発言\(これがあなたの喋り方/, 'botの過去の出力を喋り方の手本にしない');
  assert.match(sys, /最近の自分の発言\(同じ文・同じ締め方を繰り返さないための参考/);
});

test('本人のコーパスでないアカウントは従来どおり', () => {
  const state = { id: 'x', persona: 'p', corpusPath: path.join(__dirname, '..', 'config', 'corpus', 'default.txt'), corpusLines: own };
  assert.equal(ai.isSelfVoice(state), false);
});

test('手本から、他のbotへのコマンド・自傷に触れる行を外し、カスタム絵文字を取り除く', () => {
  assert.equal(ai.cleanExampleLine('/xp hide'), null);
  assert.equal(ai.cleanExampleLine('しげおさっきリスカしてたもんね'), null);
  assert.equal(ai.cleanExampleLine('ディスコもTwitterも切られた<:005Teetee:523365648571826187>'), 'ディスコもTwitterも切られた');
  assert.equal(ai.cleanExampleLine('やっす'), 'やっす');
});
