const { mockLLM, seedRandom } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { registerOwnAccount } = require('../src/utils/ownAccounts');
const humanTiming = require('../src/utils/humanTiming');
const selfMonitor = require('../src/utils/selfMonitor');

const DATA = path.join(__dirname, '..', 'data');
const OFFSET = path.join(DATA, 'bug-reports.offset');
const cleanup = () => [selfMonitor.REPORT_FILE, OFFSET].forEach((f) => fs.rmSync(f, { force: true }));
test.beforeEach(cleanup);
test.after(cleanup);

registerOwnAccount('bot1');
const channelWith = (msgs) => ({ id: 'c', messages: { cache: new Map(msgs.map((m) => [m.id, m])) } });
const msg = (id, authorId, content, at, extra = {}) => ({ id, author: { id: authorId, bot: false }, content, createdTimestamp: at, guild: { id: 'g' }, ...extra });

test('投稿間隔: 一様乱数ではなく指数分布(ばらつきが大きく、周期が見えない)', () => {
  const restore = seedRandom(1);
  const xs = Array.from({ length: 4000 }, () => humanTiming.exponentialDelay(1000));
  restore();
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  // ±40%の一様乱数の変動係数は約0.23。指数分布(上下を切った)は0.8前後になる
  assert.ok(sd / mean > 0.7, `変動係数 ${(sd / mean).toFixed(2)}`);
  assert.ok(Math.min(...xs) >= 100 && Math.max(...xs) <= 4000);
});

test('時間帯: データが無ければ一般的な生活リズム(夜は多く明け方はほぼ無い)', () => {
  const w = humanTiming.hourWeights(null);
  assert.ok(w[22] > 0.9 && w[5] < 0.1);
});

test('誰も反応していない自分たちの投稿が最後なら、重ねて書かない', () => {
  const now = Date.now();
  assert.equal(humanTiming.waitingForReply(channelWith([msg('1', 'human', 'x', now - 9e5), msg('2', 'bot1', 'ニュース', now - 6e5)]), now), true);
  assert.equal(humanTiming.waitingForReply(channelWith([msg('2', 'bot1', 'ニュース', now - 6e5), msg('3', 'human', 'へえ', now - 3e5)]), now), false);
  assert.equal(humanTiming.waitingForReply(channelWith([msg('2', 'bot1', 'ニュース', now - 5 * 3600000)]), now), false, '何時間も経てばまた書いてよい');
});

const client = { user: { id: 'bot1' }, accountState: { id: 'acc1' } };

test('自分の発言の不具合(途中で切れた・外国語・プロンプト漏れ)を記録し、閾値を超えたらファイルに出す', () => {
  const now = Date.now();
  const ch = channelWith([]);
  const own = (id, content) => {
    selfMonitor.noteAiPost(content);
    return msg(id, 'bot1', content, now, { channel: ch });
  };
  selfMonitor.checkOwnMessage(own('a', '先週のコンビニで買ったチョコレート急に溶けてパッケージがべちゃべちゃになってたんだけどこれって円安で仕入れが'), client);
  selfMonitor.checkOwnMessage(own('b', 'それな 안녕'), client);
  selfMonitor.checkOwnMessage(own('c', '【言う内容】知らないと言う'), client);
  const first = selfMonitor.flush();
  assert.deepEqual(first.map((r) => r.kind).sort(), ['foreign-script', 'prompt-leak'], '途中切れは2回目から');
  selfMonitor.checkOwnMessage(own('d', 'この前のRTX4090買い損したんだけど株価上がると同時に電気代が天井ギリギリになったのが地味に効いてきてて'), client);
  assert.deepEqual(selfMonitor.flush().map((r) => r.kind), ['truncated']);
  const lines = fs.readFileSync(selfMonitor.REPORT_FILE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.equal(lines.find((r) => r.kind === 'truncated').count, 2);
});

test('誰も反応していないのに同じアカウントが続けて投稿したら記録する', () => {
  const now = Date.now();
  const prev = msg('p', 'bot1', 'RTX4090の話', now - 49 * 60000);
  const ch = channelWith([prev]);
  selfMonitor.noteAiPost('チョコの話');
  for (let i = 0; i < 2; i++) selfMonitor.checkOwnMessage(msg(`n${i}`, 'bot1', 'チョコの話', now, { channel: ch }), client);
  assert.deepEqual(selfMonitor.flush().map((r) => r.kind), ['talking-to-void']);
});

test('人間にbot扱いされたら記録する。人間の発言そのものは報告に入れない(公開リポジトリのため)', () => {
  const botMsg = msg('b1', 'bot1', '円安えぐいな', Date.now());
  const ch = channelWith([botMsg]);
  selfMonitor.checkHumanMessage(
    msg('h1', 'human1', 'こいつAIだろ 山田の家の近くで見た', Date.now(), { channel: ch, mentions: { repliedUser: { id: 'bot1' } }, reference: { messageId: 'b1' } }),
    client
  );
  const [r] = selfMonitor.flush();
  assert.equal(r.kind, 'suspected-bot');
  assert.doesNotMatch(JSON.stringify(r), /山田|human1/);
  assert.deepEqual(r.samples, ['円安えぐいな']);
});

test('人格のブレをLLMで判定して記録する', async () => {
  mockLLM(() => '2|シニカルなキャラなのに素直に長い体験談を語っている');
  const st = { id: 'acc1', personaName: 'default', persona: '率直でシニカル', recentReplies: ['草', 'この前のRTX4090買い損したんだけど', 'だろ', 'はいはい'] };
  selfMonitor.register.length; // no-op
  await selfMonitor.checkPersonaDrift.call(null);
  // register前はclientsが空なので何もしない
  assert.equal(selfMonitor.flush().length, 0);
  selfMonitor.register([{ on() {}, user: null, accountState: st }]);
  await selfMonitor.checkPersonaDrift();
  const [r] = selfMonitor.flush();
  assert.equal(r.kind, 'persona-drift');
  assert.deepEqual(r.samples, ['この前のRTX4090買い損したんだけど']);
});

test('回収スクリプト: 未回収分だけ出し、ackするまで同じ分を出し続ける', () => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(selfMonitor.REPORT_FILE, '{"kind":"a"}\n{"kind":"b"}\n{"kind":"c"');
  const run = (...args) => execFileSync(process.execPath, ['scripts/export-bug-reports.js', ...args], { cwd: path.join(__dirname, '..') }).toString();
  const first = JSON.parse(run());
  assert.deepEqual(first.reports.map((r) => r.kind), ['a', 'b'], '書きかけの行は出さない');
  assert.deepEqual(JSON.parse(run()).reports.length, 2, 'ack前は同じ分をまた出す');
  run('--ack', String(first.offset));
  fs.appendFileSync(selfMonitor.REPORT_FILE, '}\n');
  assert.deepEqual(JSON.parse(run()).reports.map((r) => r.kind), ['c']);
});

test('価格アラート等の定型の投稿(AIが生成していない発言)は検査しない (issue #32)', () => {
  const now = Date.now();
  const alert = (id, at) => msg(id, 'bot1', '💰 価格アラート\n📉 **NEAR** 3.3 → 3.13 (-5.2%)', at);
  const prev = alert('a1', now - 60 * 60000);
  const ch = channelWith([prev]);
  for (let i = 0; i < 3; i++) selfMonitor.checkOwnMessage({ ...alert(`a${i + 2}`, now), channel: ch }, client);
  assert.equal(selfMonitor.flush().length, 0);
});

test('分割送信された発言の一部も、AIの発言として検査する', () => {
  selfMonitor.noteAiPost('それはそう 【言う内容】知らない');
  selfMonitor.checkOwnMessage({ ...msg('s1', 'bot1', '【言う内容】知らない', Date.now()), channel: channelWith([]) }, client);
  assert.deepEqual(selfMonitor.flush().map((r) => r.kind), ['prompt-leak']);
});

test('オウム返しと、同じ発言への二重返信を記録する(人間の発言は報告に入れない)', () => {
  const now = Date.now();
  const human = msg('h', 'human', '近平の白髪増えたなぁ', now - 3600000);
  const first = msg('r1', 'bot1', '白髪増えてんのか😦', now - 1800000, { reference: { messageId: 'h' } });
  const ch = channelWith([human, first]);
  selfMonitor.noteAiPost('白髪増えてんのか😦');
  selfMonitor.noteAiPost('白髪増えてんのか😭');
  selfMonitor.checkOwnMessage({ ...first, channel: ch }, client);
  const second = msg('r2', 'bot1', '白髪増えてんのか😭', now, { reference: { messageId: 'h' } });
  ch.messages.cache.set('r2', second);
  selfMonitor.checkOwnMessage({ ...second, channel: ch }, client);
  const kinds = selfMonitor.flush().map((r) => r.kind).sort();
  assert.ok(kinds.includes('parrot') && kinds.includes('duplicate-reply'), kinds.join(','));
  assert.doesNotMatch(fs.readFileSync(selfMonitor.REPORT_FILE, 'utf8'), /近平/);
});

test('人格判定で「一覧に無い絵文字」だけの指摘は報告しない (issue #49)', async () => {
  assert.equal(selfMonitor.isEmojiOnlyReason('使用している絵文字が設定にない 😏。他は設定と合致している。'), true);
  assert.equal(selfMonitor.isEmojiOnlyReason('絵文字が一覧に無い'), true);
  assert.equal(selfMonitor.isEmojiOnlyReason('絵文字が設定にない上に、句読点を使っている'), false);
  assert.equal(selfMonitor.isEmojiOnlyReason('シニカルなキャラなのに素直に長い体験談を語っている'), false);
  mockLLM(() => '1|使用している絵文字が設定にない 😏。他は設定と合致している。');
  const st = { id: 'acc2', personaName: 'suisui', persona: '気分屋', recentReplies: ['原神の新イベント甘すぎて笑える 😏', 'a', 'b', 'c'] };
  selfMonitor.register([{ on() {}, user: null, accountState: st }]);
  await selfMonitor.checkPersonaDrift();
  assert.equal(selfMonitor.flush().length, 0);
});

test('反応の無い投稿が2回続いたら、人間が書くまで黙る。4時間空けた2回目までは許す (issue #58)', () => {
  const now = Date.now();
  const h = 3600000;
  const human = msg('h', 'human', 'x', now - 10 * h);
  const own1 = msg('o1', 'bot1', '呪術廻戦の話', now - 5 * h);
  const own2 = msg('o2', 'bot1', '金価格の話', now - 30 * 60000);
  assert.equal(humanTiming.shouldHoldOff([human, own1], now), false, '1回目から4時間経てば2回目はよい');
  assert.equal(humanTiming.shouldHoldOff([human, own1, own2], now), true, '2回続いたら黙る');
  assert.equal(humanTiming.shouldHoldOff([human, own1, own2, msg('h2', 'human', 'へえ', now - 60000)], now), false);
  // AI同士の掛け合い(リプライの連なり)は1回の投稿として数える
  const seed = [msg('s1', 'bot1', 'a', now - 5 * h), msg('s2', 'bot1', 'b', now - 5 * h + 1000, { reference: { messageId: 's1' } })];
  assert.equal(humanTiming.unansweredRun(seed).count, 1);
});
