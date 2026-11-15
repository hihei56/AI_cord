const config = require('./config');

// 分割送信: 人間は2つ以上のことを言う時、1通にまとめずに2通に分けて送ることが多い。
// 一定確率で、返信を区切り(空白)で2つに分け、2通目は少し間を空けて送る。
// 中身は変えず、区切る位置だけを決める(1通目が短すぎ・2通目が短すぎにならない位置)
const S = { chance: 0.25, minLength: 20, minPartLength: 6, ...(config.splitSend || {}) };

// 文末らしい終わり方(この直後の空白なら、文の切れ目とみなせる)。「わかる 気はする」のような
// 言葉の途中の空白で切らないよう、ここに当てはまる位置でしか分けない。「る」「い」で終わる語は
// 「わかる気」「寒い日」のように後ろへ続くことが多いので含めない
const SENTENCE_END_RE = /(?:[だろなよねわさかぞぜのした]|じゃん|っしょ|けど|[wｗ草笑!?！？…])$/;

function splitPoint(text) {
  const mid = text.length / 2;
  let best = -1;
  for (const m of text.matchAll(/ /g)) {
    const left = m.index;
    if (!SENTENCE_END_RE.test(text.slice(0, left))) continue;
    const right = text.length - left - 1;
    if (left < S.minPartLength || right < S.minPartLength) continue;
    if (best === -1 || Math.abs(left - mid) < Math.abs(best - mid)) best = left;
  }
  return best;
}

// 分けるなら [1通目, 2通目]、分けないなら [text]
function maybeSplit(text) {
  if (!text || text.length < S.minLength || Math.random() >= S.chance) return [text];
  const at = splitPoint(text);
  return at === -1 ? [text] : [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1通目はリプライとして送り、2通目は入力中表示を出してから普通に続けて送る。
// 返り値は1通目のメッセージ(会話の続きや乗っかりの参照先になる)
async function sendMaybeSplit(channel, text, replyOptions = null) {
  const parts = maybeSplit(text);
  const first = await channel.send(replyOptions ? { content: parts[0], ...replyOptions } : parts[0]);
  if (parts.length > 1) {
    const { perCharMs = 70, jitterMs = 2000 } = config.replyDelay || {};
    await channel.sendTyping().catch(() => {});
    await sleep(Math.min(parts[1].length * perCharMs, 6000) + Math.random() * jitterMs);
    await channel.send(parts[1]);
  }
  return first;
}

module.exports = { sendMaybeSplit, maybeSplit };
