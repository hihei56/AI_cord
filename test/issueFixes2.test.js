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

test('画像読み取りが3回続けて失敗したら、しばらく試さない (issue #65)', async () => {
  const config = require('../src/utils/config');
  config.ai.vision = { ...(config.ai.vision || {}), enabled: true };
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: false, status: 503, statusText: '', headers: { get: () => null }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  ai._visionHealth.failures = 0;
  ai._visionHealth.pausedUntil = 0;
  for (let i = 0; i < 3; i++) await ai.describeImage('https://example.com/a.png');
  assert.ok(ai._visionHealth.pausedUntil > Date.now());
  const before = calls;
  assert.equal(await ai.describeImage('https://example.com/b.png'), null);
  assert.equal(calls, before, '止めている間は接続先に問い合わせない');
  ai._visionHealth.pausedUntil = 0;
});

test('5chの一時的な障害(HTTP 5xx)は、続いた時だけエラーにする (issue #68)', () => {
  const logger = require('../src/utils/logger');
  const errors = [];
  const orig = logger.error;
  logger.error = (tag, e) => errors.push(String(e));
  try {
    const { reportFetchFailure } = require('../src/handlers/houseWatchHandler');
    for (let i = 0; i < 5; i++) reportFetchFailure(new Error('https://example/subject.txt -> HTTP 522'));
    assert.equal(errors.length, 0);
    for (let i = 0; i < 10; i++) reportFetchFailure(new Error('https://example/subject.txt -> HTTP 522'));
    assert.equal(errors.length, 1, '15回続いたら1回だけエラー');
  } finally {
    logger.error = orig;
  }
});

test('suisuiの人格設定は、本物の喋り方どおり、ふざけた丁寧語を許す (issue #67)', () => {
  const persona = require('fs').readFileSync(require('path').join(__dirname, '..', 'config', 'personas', 'suisui.txt'), 'utf8');
  assert.doesNotMatch(persona, /敬語は使わない/);
  assert.match(persona, /ふざけてわざと丁寧語/);
});

test('見送りの合図(SKIP)が文中・文末にあっても投稿しない。見送りを許さない時は合図だけ取り除く (issue #70)', async () => {
  const config = require('../src/utils/config');
  config.markov.enabled = false;
  config.ai.twoStage.enabled = false;
  const st = () => ({ id: 'skip', persona: 'p', recentReplies: [] });
  const sp = { author: { id: 'u', username: 'u' }, member: null };
  mockLLM(() => 'は？ SKIP');
  assert.equal(await ai.getAIResponse(st(), 'おはよう', [], sp, { allowSkip: true }), null);
  mockLLM(() => 'は？ SKIP');
  assert.equal(await ai.getAIResponse(st(), 'おはよう', [], sp, {}), 'は？');
  mockLLM(() => 'SKIPPEDって何');
  assert.equal(await ai.getAIResponse(st(), 'おはよう', [], sp, { allowSkip: true }), 'SKIPPEDって何', '単語の一部は合図ではない');
});
