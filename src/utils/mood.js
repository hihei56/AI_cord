const crypto = require('crypto');
const config = require('./config');
const { hourOfDayJST, todayJST } = require('./datetime');

// アカウントごとの「気分」。人間らしさは安定した正しさではなく、その時の気分で口数・
// 言い方・ノリが揺れることから来る。毎回同じ調子で返すと、内容が良くても機械に見える。
//
// 気分は2つの軸で持つ: energy(元気さ: 眠い/だるい〜テンション高い)と
// valence(機嫌: 不機嫌〜上機嫌)。それぞれ -1〜1。
// - 時間とともにランダムに漂う(平均に戻りつつ揺れるOU過程)。数時間単位でゆっくり変わる
// - 平均は時間帯(夜型: 朝は低く夜は高い)と「その日の調子」(日付とアカウントで決まる)で動く
// - 出来事でも動く: 話しかけられると少し上がり、喋り続けると疲れて下がる
// 返信するかどうかの確率・口数・言い方(プロンプト)・温度に効かせる
const M = {
  enabled: true,
  tauHours: 3, // 平均に戻る速さ(時間)
  sigma: 0.45, // 揺れの大きさ
  dayOffset: 0.35, // 「その日の調子」の幅
  circadian: 0.35, // 時間帯による元気さの振れ幅
  peakHourJST: 23, // 一番元気な時刻
  quirkChance: 0.15, // 返信ごとに「いつもと違う返し方」を指示する確率
  ...(config.mood || {})
};

const clamp = (x) => Math.max(-1, Math.min(1, x));

function gaussian() {
  const u = 1 - Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

// 文字列から決まる -1〜1 の値(再起動しても同じ日は同じ「調子」になる)
function hashUnit(str) {
  return (crypto.createHash('md5').update(str).digest().readUInt16BE(0) / 65535) * 2 - 1;
}

function baseline(accountId) {
  const day = todayJST();
  // アカウントごとに生活リズムを少しずらす(全員が同じ時刻に元気にならないように)
  const phase = hashUnit(`phase:${accountId}`) * 2;
  const circ = Math.cos(((hourOfDayJST() - M.peakHourJST - phase) / 24) * 2 * Math.PI) * M.circadian;
  return {
    energy: circ + hashUnit(`e:${day}:${accountId}`) * M.dayOffset,
    valence: hashUnit(`v:${day}:${accountId}`) * M.dayOffset
  };
}

// 今の気分を返す(呼ぶたびに、前回からの経過時間ぶん漂わせる)
function current(accountState) {
  if (!M.enabled || !accountState) return { energy: 0, valence: 0 };
  const base = baseline(accountState.id);
  const now = Date.now();
  const m = accountState.mood || { energy: base.energy, valence: base.valence, at: now - M.tauHours * 3600000 };
  const dtHours = Math.max(0, (now - m.at) / 3600000);
  const keep = Math.exp(-dtHours / M.tauHours);
  const noise = M.sigma * Math.sqrt(1 - keep * keep);
  accountState.mood = {
    energy: clamp(base.energy + (m.energy - base.energy) * keep + gaussian() * noise),
    valence: clamp(base.valence + (m.valence - base.valence) * keep + gaussian() * noise),
    at: now
  };
  return accountState.mood;
}

// 出来事で気分を動かす
function nudge(accountState, { energy = 0, valence = 0 }) {
  if (!M.enabled || !accountState) return;
  const m = current(accountState);
  m.energy = clamp(m.energy + energy);
  m.valence = clamp(m.valence + valence);
}

const HIGH = 0.3;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const LABELS = {
  upbeat: ['機嫌がよくてテンション高め。口数が少し増える', 'なんか調子がいい。反応が早くて軽い'],
  irritated: ['少しイライラしてる。返事が短くなる', '虫の居所が悪い。口数が減る'],
  mellow: ['まったりしてる。反応はゆるい', '機嫌はいいけど眠い。返事がのんびりする'],
  tired: ['だるくて眠い。反応が薄い', '疲れてる。口数が減る'],
  energetic: ['元気が余ってる。口数が少し増える'],
  sleepy: ['眠い。返事が短くなる'],
  good: ['機嫌がいい'],
  bad: ['ちょっと不機嫌。返事が短くなる']
};

function labelKey({ energy, valence }) {
  const e = energy > HIGH ? 1 : energy < -HIGH ? -1 : 0;
  const v = valence > HIGH ? 1 : valence < -HIGH ? -1 : 0;
  if (e > 0 && v > 0) return 'upbeat';
  if (e > 0 && v < 0) return 'irritated';
  if (e < 0 && v > 0) return 'mellow';
  if (e < 0 && v < 0) return 'tired';
  if (e > 0) return 'energetic';
  if (e < 0) return 'sleepy';
  if (v > 0) return 'good';
  if (v < 0) return 'bad';
  return null;
}

// たまに入れる「いつもと違う返し方」。気分で出やすいものが変わる
// 揺らすのは「口数」と「返し方の形」だけにする。以前は「茶化す」「素直に共感する」のように
// 態度そのものを変える指示も混ぜていたが、人格の口調と衝突して、1つの発言の中で
// 普通に答えた直後に突き放すような継ぎはぎの文になり、別人のように見えていた。
// 人の気分で揺れるのは口数やテンションで、喋り方(一人称・語尾)は揺れない
const QUIRKS = [
  { text: '今回は単語か一言だけで返す(5文字前後)', weight: (m) => 1 + Math.max(0, -m.energy) * 2 },
  { text: '今回はいつもより少しだけ長めに喋る', weight: (m) => 0.5 + Math.max(0, m.energy) * 2 },
  { text: '今回は相手に軽く質問を返す', weight: (m) => 0.5 + Math.max(0, m.valence) }
];

function pickQuirk(mood) {
  if (Math.random() >= M.quirkChance) return null;
  const weights = QUIRKS.map((q) => q.weight(mood));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < QUIRKS.length; i++) {
    if ((r -= weights[i]) <= 0) return QUIRKS[i].text;
  }
  return QUIRKS.at(-1).text;
}

// プロンプトに入れる気分の説明(平常時は何も入れない)
function promptSection(accountState) {
  if (!M.enabled) return '';
  const mood = current(accountState);
  const key = labelKey(mood);
  const quirk = pickQuirk(mood);
  const lines = [
    key ? `今の気分: ${pick(LABELS[key])}(変わるのは口数とテンションだけ。一人称・語尾・性格はいつも通り。気分を説明・宣言しない)` : null,
    quirk
  ].filter(Boolean);
  return lines.length ? `\n【今回の調子】\n- ${lines.join('\n- ')}` : '';
}

module.exports = {
  current,
  nudge,
  promptSection,
  labelKey,
  // 呼ばれていない発言に返信する確率の倍率(元気な時ほど絡む): 0.5〜1.5
  replyChanceFactor: (accountState) => (M.enabled ? 1 + current(accountState).energy * 0.5 : 1),
  // 生成の温度の上乗せ(元気な時ほど発言が散らかる): -0.08〜+0.08。大きくすると
  // 口調が崩れたり言語を取り違えたりしやすいので小さくしている
  temperatureOffset: (accountState) => (M.enabled ? current(accountState).energy * 0.08 : 0),
  MOOD: M
};
