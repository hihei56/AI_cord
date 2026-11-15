const { mockLLM } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readJson } = require('../src/utils/jsonFile');
const knowledgeBase = require('../src/utils/knowledgeBase');
const userRules = require('../src/utils/userRules');
const { isHuman } = require('../src/utils/humanPresence');
const { registerOwnAccount } = require('../src/utils/ownAccounts');

test('壊れたJSONは退避して空の状態で続行する。無いファイルは黙って初期値', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicord-'));
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{"a":1,');
  assert.deepEqual(readJson(file, { x: 0 }), { x: 0 });
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('broken.json.broken')).length, 1);
  assert.deepEqual(readJson(path.join(dir, 'none.json'), []), []);
  fs.rmSync(dir, { recursive: true });
});

test('知識ベース: 内輪の質問で該当する項目を引き、無関係な話では引かない', () => {
  const first = (q) => (knowledgeBase.lookup(q)[0] || '').split('\n')[0];
  assert.match(first('麻痺斗って何歳'), /麻痺斗.*どんな人/);
  assert.match(first('itokuって誰'), /itoku/);
  assert.match(first('その名はラオウって何'), /ラオウ/);
  assert.equal(knowledgeBase.lookup('今日の夕飯なに食べた？').length, 0);
  assert.equal(knowledgeBase.lookup('一番好きな食べ物は').length, 0);
});

test('特定の相手への接し方: 相手と適用アカウントで絞り込む', () => {
  const mahito = { username: 'banniuke' };
  const azarashi = { username: 'azarashi1395' };
  const other = { username: 'someone' };
  assert.equal(userRules.rulesFor(mahito, null, azarashi, null).replyChance, 0.8);
  assert.ok(userRules.rulesFor(mahito, null, azarashi, null).instructions.length > userRules.rulesFor(mahito, null, other, null).instructions.length);
  assert.equal(userRules.rulesFor({ username: 'x' }, { nickname: '麻痺斗' }, other, null).instructions.length > 0, true);
  assert.equal(userRules.rulesFor(other, null, azarashi, null).instructions.length, 0);
});

test('人間の発言の判定: Webhookプロキシ経由は人間、本物のbotと自分たちは除く', () => {
  registerOwnAccount('self-id');
  assert.equal(isHuman({ author: { id: 'h', bot: false } }), true);
  assert.equal(isHuman({ author: { id: 'w', bot: true }, webhookId: '1' }), true);
  assert.equal(isHuman({ author: { id: 'b', bot: true } }), false);
  assert.equal(isHuman({ author: { id: 'self-id', bot: false } }), false);
});

test('ニュース: 経済ニュースを概要つきで取り、お題に元ネタを付ける', async () => {
  const rss = '<rss><channel><title>NHK</title><item><title><![CDATA[日経平均 800円値下がり]]></title><description>半導体関連を中心に売り。</description></item></channel></rss>';
  const calls = mockLLM((url, body) => (body && JSON.stringify(body).includes('お題を1つだけ決めて') ? '1|株が急落した話' : 'x'));
  const llmFetch = global.fetch;
  global.fetch = async (url, opts) => (String(url).includes('nhk.or.jp') ? { ok: true, text: async () => rss } : llmFetch(url, opts));
  const { planConversationTopic } = require('../src/utils/aiClient');
  const topic = await planConversationTopic('p1', 'p2');
  assert.match(topic, /株が急落した話/);
  assert.match(topic, /日経平均 800円値下がり/);
  assert.ok(calls.length >= 1);
});
