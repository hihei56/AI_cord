// テスト共通: 外部APIのキーをダミーにし、fetchを差し替えられるようにする。
// 本物のAPI・Discordには一切つながない
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-key';
delete process.env.LOGFARE_API_KEY;
delete process.env.AI_PROVIDER;

// 応答を返すfetchのモック。handler(url, body) が文字列を返したらその文で正常応答する
function mockLLM(handler) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const content = handler(url, body, calls.length);
    if (content instanceof Error) {
      return { ok: false, status: 503, statusText: '', headers: { get: () => null }, json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return calls;
}

// Math.randomを固定値に(戻す関数を返す)
function fixRandom(value) {
  const original = Math.random;
  Math.random = () => value;
  return () => {
    Math.random = original;
  };
}

// Math.randomを、シードから毎回同じ列を返す乱数に差し替える(確率的な処理を決定的にテストするため)
function seedRandom(seed) {
  const original = Math.random;
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    Math.random = original;
  };
}

module.exports = { mockLLM, fixRandom, seedRandom };
