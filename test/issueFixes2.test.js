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

test('災害・事故・事件のニュースは雑談のネタにしない', () => {
  const { isSafe } = require('../src/utils/newsTopics');
  assert.equal(isSafe({ title: '熊本で震度5弱の地震' }), false);
  assert.equal(isSafe({ title: '日経平均が反落、円安一服' }), true);
  assert.equal(isSafe({ title: '首都高で多重事故' }), false);
});

test('保存された直近の発言から、返信言語と違う文字(昔のタミル語)の発言を外す (issue #54)', () => {
  const { usableRecentReplies } = require('../src/account');
  const saved = ['நேரம் வேகமா ஓடுது, பீட்சா சாப்பிடலாமா?', 'それはない', 'அப்படியா'];
  assert.deepEqual(usableRecentReplies(saved, null), ['それはない']);
  assert.deepEqual(usableRecentReplies(saved, 'タミル語'), saved, '言語を固定しているアカウントはそのまま');
});

test('画像を読めないプロバイダが選ばれていたら、画像を読めるプロバイダで読む (issue #53)', () => {
  const keys = { CLOUDFLARE_API_KEY: 'k', CLOUDFLARE_ACCOUNT_ID: 'acc', VISION_AI_PROVIDER: 'cloudflare' };
  const saved = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  Object.assign(process.env, keys);
  // baseUrlはモジュール読み込み時に決まるので読み直す
  delete require.cache[require.resolve('../src/utils/aiProvider')];
  try {
    const aiProvider = require('../src/utils/aiProvider');
    assert.equal(aiProvider.getConnection('vision').provider, 'groq');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[require.resolve('../src/utils/aiProvider')];
  }
});

test('一度返信した発言には、見える範囲から外れても同じアカウントは返信しない (issue #56)', () => {
  const { registerOwnAccount } = require('../src/utils/ownAccounts');
  registerOwnAccount('bot-reg');
  const registry = require('../src/utils/replyRegistry');
  registry.record({ author: { id: 'bot-reg' }, reference: { messageId: 'human-1' } });
  registry.record({ author: { id: 'stranger' }, reference: { messageId: 'human-2' } });
  assert.equal(registry.hasReplied('bot-reg', 'human-1'), true);
  assert.equal(registry.hasReplied('bot-other', 'human-1'), false);
  assert.equal(registry.anyReplied('human-2'), false, '人間のリプライは数えない');
  // エージェントは直近の発言一覧に自分の返信が無くても、台帳を見て返信しない
  const { isReplyable } = require('../src/handlers/agentHandler');
  const human = { id: 'human-1', author: { id: 'mirei', bot: false }, content: 'x', createdTimestamp: Date.now() - 30 * 60000 };
  assert.equal(isReplyable(human, [human]), false);
});
