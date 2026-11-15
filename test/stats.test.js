const { seedRandom } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createEngagementStats } = require('../src/utils/engagementStats');

// 統計の保存は非同期の書き込みなので、全テストが終わってから作ったファイルを消す
test.after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  for (const id of ['test-good', 'test-harm', 'test-step']) {
    fs.rmSync(path.join(__dirname, '..', 'data', `agent-stats-${id}.json`), { force: true });
  }
});

function poisson(lambda) {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > limit);
  return k - 1;
}

function simulate(id, truth, steps, seed) {
  const restore = seedRandom(seed);
  const file = path.join(__dirname, '..', 'data', `agent-stats-${id}.json`);
  fs.rmSync(file, { force: true });
  const stats = createEngagementStats(id);
  const counts = {};
  for (let i = 0; i < steps; i++) {
    const a = stats.thompsonPick(Object.keys(truth));
    counts[a] = (counts[a] || 0) + 1;
    stats.addResult(a, poisson(truth[a]));
  }
  restore();
  return { counts, multiplier: stats.intervalMultiplier() };
}

test('トンプソン抽出: 効く行動に収束する', () => {
  const { counts, multiplier } = simulate('test-good', { wait: 1, topic: 2, question: 2.5, news: 1.2 }, 300, 1);
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(best, 'question');
  assert.equal(multiplier, 1);
});

test('トンプソン抽出: 何をしても逆効果なら黙る方に寄り、間隔を伸ばす', () => {
  const { counts, multiplier } = simulate('test-harm', { wait: 2, topic: 1, question: 1.2, news: 0.9 }, 600, 7);
  assert.ok(counts.wait > 400, `waitの回数: ${counts.wait}`);
  assert.ok(multiplier > 1, `倍率: ${multiplier}`);
});

test('行動間隔の調整は、新しい結果が10件溜まるごとに1段階ずつ', () => {
  const file = path.join(__dirname, '..', 'data', 'agent-stats-test-step.json');
  fs.rmSync(file, { force: true });
  const stats = createEngagementStats('test-step');
  for (let i = 0; i < 10; i++) stats.addResult('wait', 3);
  for (let i = 0; i < 20; i++) stats.addResult('topic', 0);
  assert.equal(stats.intervalMultiplier(), 1.5, '有意差が出た時点で1段階');
  for (let i = 0; i < 9; i++) stats.addResult('topic', 0);
  assert.equal(stats.intervalMultiplier(), 1.5, '9件では動かない');
  stats.addResult('topic', 0);
  assert.equal(stats.intervalMultiplier(), 2.25, '10件目で次の段階');
});
