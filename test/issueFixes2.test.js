const { mockLLM } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/utils/aiClient');
const usageLedger = require('../src/utils/usageLedger');
const selfMonitor = require('../src/utils/selfMonitor');

test('お🏡スレ通知: 権限が無いアカウントは外し、送れないスレは3回で諦める (issue #36〜#38, #43)', async () => {
  const store = require('../src/utils/houseWatchStore');
  const seen = [];
  const origMark = store.markSeen;
  store.markSeen = (keys) => seen.push(...keys);
  const registry = require('../src/utils/accountRegistry');
  const noAccess = Object.assign(new Error('Missing Access'), { code: 50001 });
  let sends = 0;
  const mkClient = (id) => ({
    accountState: { id },
    isReady: () => true,
    channels: { cache: new Map([['ch', { send: async () => { sends++; throw noAccess; } }]]) }
  });
  const origAll = registry.getAllClients;
  const clients = [mkClient('1'), mkClient('2')];
  registry.getAllClients = () => clients;
  try {
    const { sendWithFallback } = require('../src/handlers/houseWatchHandler');
    const t = { key: '123', title: 'スレタイ' };
    assert.equal(await sendWithFallback('ch', 'url', t), false);
    assert.equal(sends, 2);
    // 2回目以降は権限の無いアカウントに送らない
    await sendWithFallback('ch', 'url', t);
    await sendWithFallback('ch', 'url', t);
    assert.equal(sends, 2);
    assert.deepEqual(seen, ['123'], '3回送れなかったら通知済みにして再送をやめる');
  } finally {
    registry.getAllClients = origAll;
    store.markSeen = origMark;
  }
});

test('レート制限(429)はエラー扱いにせず、モデルが無い(404/410)プロバイダは長めに止める (issue #39〜#41)', async () => {
  const errors = [];
  const logger = require('../src/utils/logger');
  const origError = logger.error;
  logger.error = (tag, e) => errors.push(String(e));
  try {
    let status = 429;
    global.fetch = async () => ({ ok: false, status, statusText: '', headers: { get: () => '1' }, json: async () => ({ error: 'x' }) });
    await ai.callChatCompletion([{ role: 'user', content: 'x' }], { baseUrl: 'https://a.example/v1', apiKey: 'k', model: 'm' });
    assert.equal(errors.length, 0, '429はエラーにしない');
    status = 410;
    await ai.callChatCompletion([{ role: 'user', content: 'x' }], { baseUrl: 'https://b.example/v1', apiKey: 'k', model: 'gone' });
    assert.equal(errors.length, 1);
    assert.equal(usageLedger.isCoolingDown('https://b.example/v1'), true, '廃止されたモデルの接続先は止める');
  } finally {
    logger.error = origError;
  }
});

test('使えない明示指定のプロバイダは無視し、接続先URLが空の所には送らない (issue #42)', async () => {
  const aiProvider = require('../src/utils/aiProvider');
  process.env.SEED_AI_PROVIDER = 'cloudflare';
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  try {
    const conn = aiProvider.getConnection('seed');
    assert.notEqual(conn.provider, 'cloudflare');
    assert.ok(conn.baseUrl);
  } finally {
    delete process.env.SEED_AI_PROVIDER;
  }
});

test('監視役のエラー報告から、スレタイ等の中身を落とす (issue #38, #43)', () => {
  assert.equal(selfMonitor.sanitizeError('全アカウントで送信失敗: 1763456789 Jガイルきたよ👊😅👊🏡'), '全アカウントで送信失敗');
  assert.equal(selfMonitor.sanitizeError('[2] 送信失敗、次のアカウントで再試行: Missing Access'), '[2] 送信失敗、次のアカウントで再試行: Missing Access');
});
