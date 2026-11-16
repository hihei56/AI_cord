const { mockLLM } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createMemoryStore } = require('../src/utils/memoryStore');
const ai = require('../src/utils/aiClient');
const serverMemory = require('../src/utils/serverMemory');
const { registerOwnAccount } = require('../src/utils/ownAccounts');

const DATA = path.join(__dirname, '..', 'data');
const memFile = (id) => path.join(DATA, `memory-${id}.json`);

test.after(async () => {
  await new Promise((r) => setTimeout(r, 2500)); // 記憶の保存は2秒まとめの非同期書き込み
  for (const id of ['test-acc', 'test-migrate', 'test-shrink']) fs.rmSync(memFile(id), { force: true });
  serverMemory.clear('test-guild');
});

test('人ごとの記憶は、まとめ直しても前の内容を引き継いで積み上がる', async () => {
  fs.rmSync(memFile('test-acc'), { force: true });
  const store = createMemoryStore('test-acc');
  const state = { id: 'test-acc', memoryStore: store };
  let round = 0;
  const prompts = [];
  mockLLM((url, body) => {
    prompts.push(body.messages[0].content);
    round++;
    return round === 1 ? '- ラーメンが好き\n- 夜型' : '- ラーメンが好き\n- 夜型\n- 最近猫を飼い始めた(最近)';
  });

  for (let i = 0; i < 8; i++) ai.recordMemory(state, 'u1', 'bob', `ラーメンの話${i}`, '返事');
  await ai.compressUserMemoryIfNeeded(state, 'u1', 'bob');
  assert.deepEqual(store.getFacts('u1'), ['ラーメンが好き', '夜型']);
  assert.equal(store.getRaw('u1').length, 0, 'まとめたやり取りは消える');

  // 以前はここで要約が捨てられていた
  ai.recordMemory(state, 'u1', 'bob', '猫飼い始めた', 'いいね');
  assert.ok(store.getUserNotes('u1').includes('ラーメンが好き'), '次のやり取りが来ても前の記憶は残る');
  assert.ok(store.getUserNotes('u1').some((n) => n.includes('猫飼い始めた')), 'まとめ前のやり取りもすぐ使える');

  for (let i = 0; i < 7; i++) ai.recordMemory(state, 'u1', 'bob', `猫の話${i}`, '返事');
  await ai.compressUserMemoryIfNeeded(state, 'u1', 'bob');
  assert.match(prompts[1], /これまでに分かっていること[\s\S]*ラーメンが好き/, '2回目のまとめに前の記憶を渡している');
  assert.deepEqual(store.getFacts('u1'), ['ラーメンが好き', '夜型', '最近猫を飼い始めた(最近)']);
});

test('まとめ直しが壊れて極端に短くなったら、それまでの記憶を消さない', async () => {
  fs.rmSync(memFile('test-shrink'), { force: true });
  const store = createMemoryStore('test-shrink');
  const state = { id: 'test-shrink', memoryStore: store };
  store.setFacts('u1', ['a', 'b', 'c', 'd', 'e', 'f'], 0);
  for (let i = 0; i < 8; i++) ai.recordMemory(state, 'u1', 'bob', `x${i}`, 'y');
  mockLLM(() => '- a');
  await ai.compressUserMemoryIfNeeded(state, 'u1', 'bob');
  assert.equal(store.getFacts('u1').length, 6);
});

test('旧形式の記憶ファイルを引き継ぐ', () => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(
    memFile('test-migrate'),
    JSON.stringify({ users: { done: { notes: ['要約済みの記憶'], summarized: true }, raw: { notes: ['生のやり取り'], summarized: false } } })
  );
  const store = createMemoryStore('test-migrate');
  assert.deepEqual(store.getFacts('done'), ['要約済みの記憶']);
  assert.deepEqual(store.getRaw('raw'), ['生のやり取り']);
});

test('サーバーの出来事: 会話が溜まったら記録にまとめ、関係する話題で思い出す', async () => {
  serverMemory.clear('test-guild');
  registerOwnAccount('bot-self');
  mockLLM(() => 'bobとaliceがモンハンの新作の発売日で盛り上がった');
  const channel = { id: 'ch1', name: 'zatsudan' };
  const guild = { id: 'test-guild' };
  const now = Date.now();
  for (let i = 0; i < 12; i++) {
    serverMemory.record(
      { id: `m${i}`, guild, channel, author: { id: i % 2 ? 'a' : 'b', username: i % 2 ? 'alice' : 'bob', bot: false }, member: null, content: `モンハンの話${i}`, createdTimestamp: now - (12 - i) * 1000 },
      () => true
    );
  }
  await new Promise((r) => setTimeout(r, 50));
  const recalled = serverMemory.recall('モンハンいつ出るんだっけ', 'test-guild');
  assert.equal(recalled.length, 1);
  assert.match(recalled[0], /^\d+\/\d+: bobとaliceがモンハン/);
  assert.equal(serverMemory.recall('関係ない話', 'other-guild').length, 0, '別のサーバーの記録は出さない');
});

test('サーバーの出来事: 中身の無い会話は記録しない。止まった会話は少なくてもまとめる', async () => {
  serverMemory.clear('test-guild');
  mockLLM(() => 'なし');
  const channel = { id: 'ch2', name: 'x' };
  const guild = { id: 'test-guild' };
  const old = Date.now() - 60 * 60000;
  for (let i = 0; i < 5; i++) {
    serverMemory.record({ id: `n${i}`, guild, channel, author: { id: 'h', username: 'h', bot: false }, member: null, content: 'おはよ', createdTimestamp: old }, () => true);
  }
  serverMemory.flushIdle();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(serverMemory.recent(10, 'test-guild').length, 0);
});

test('返信のプロンプトに、人ごとの記憶とサーバーの出来事が入る', async () => {
  serverMemory.clear('test-guild');
  mockLLM(() => 'bobがラーメン二郎に初めて行った話をした');
  const guild = { id: 'test-guild' };
  for (let i = 0; i < 12; i++) {
    serverMemory.record({ id: `r${i}`, guild, channel: { id: 'ch3', name: 'x' }, author: { id: 'b', username: 'bob', bot: false }, member: null, content: `ラーメン二郎${i}`, createdTimestamp: Date.now() }, () => true);
  }
  await new Promise((r) => setTimeout(r, 50));
  const store = createMemoryStore('test-acc');
  store.setFacts('u9', ['辛いものが苦手'], 0);
  const calls = mockLLM(() => 'それな');
  const config = require('../src/utils/config');
  config.markov.enabled = false;
  config.ai.twoStage.enabled = false;
  await ai.getAIResponse({ id: 'test-acc', persona: 'p', recentReplies: [], memoryStore: store }, 'ラーメン二郎また行きたい', [], { author: { id: 'u9', username: 'bob' }, member: null, guildId: 'test-guild' }, {});
  const sys = calls.at(-1).body.messages[0].content;
  assert.match(sys, /辛いものが苦手/);
  assert.match(sys, /このサーバーで前にあったこと[\s\S]*ラーメン二郎に初めて行った/);
});
