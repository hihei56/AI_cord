const logger = require('./logger');
const { hourOfDayJST } = require('./datetime');
const { isOwnAccount } = require('./ownAccounts');

// 自発投稿(ニュースのつぶやき・独り言・AI同士の会話の口火)のタイミングを人間らしくする。
//
// 以前は「基準間隔±40%の一様乱数」で次回を決めていた。90分なら54〜126分の間にほぼ等間隔で
// 投稿され、深夜も昼も同じペースで、誰も反応していなくても喋り続けていた。人間の投稿は
//   1. 間隔がバラバラ(すぐ続けて書くこともあれば、何時間も書かないこともある)
//   2. 時間帯で頻度が大きく違う(夜は多く、明け方はほぼゼロ)
//   3. 誰も反応しない所に、何度も続けては書かない
// ので、これを次のように再現する:
//   1. 次回までの待ち時間を指数分布から引く(ポアソン過程。平均は同じでも、間隔のばらつきが
//      一様乱数より大きく、規則的な周期が見えなくなる)
//   2. 起きた時に「その時間帯の人間の活動量(ピーク比)」の確率でだけ実行する(間引き法。
//      時間帯で頻度が変わるポアソン過程になる)。活動量はそのサーバーの直近14日の人間の発言から
//      求め、データが少ないうちは一般的な生活リズムの曲線を使う
//   3. 自分(どのアカウントでも)の最後の投稿に人間がまだ反応していない間は投稿しない

// 日本時間0〜23時の一般的なDiscordの活動量(ピーク=1)。夜が多く、明け方はほぼゼロ
const DEFAULT_CURVE = [0.75, 0.55, 0.35, 0.2, 0.1, 0.06, 0.08, 0.15, 0.25, 0.3, 0.35, 0.4, 0.5, 0.45, 0.4, 0.4, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95, 1, 0.9];
// この件数に満たないうちは既定の曲線と混ぜる(少ないデータの時間帯別の偏りは誤差が大きい)
const PRIOR_WEIGHT_MESSAGES = 300;
// 間引きで一切動かなくなる時間帯を作らない最低値(明け方に1件も無いのは不自然ではないが、完全ゼロにはしない)
const MIN_WEIGHT = 0.03;
// 待ち時間の極端な値を切る(指数分布はまれに平均の5倍以上を引く)
const MIN_DELAY_RATIO = 0.1;
const MAX_DELAY_RATIO = 4;
// 反応が無いまま放置されていても、これだけ経てばまた書いてよい(半日誰もいない所で一言は自然)
const UNANSWERED_RETRY_MS = 4 * 3600000;

function hourWeights(guildId) {
  let counts = null;
  try {
    counts = guildId ? require('./serverStats').hourlyHumanCounts(guildId) : null;
  } catch {
    counts = null;
  }
  const total = counts ? counts.reduce((a, b) => a + b, 0) : 0;
  const peakCount = total ? Math.max(...counts) : 0;
  // 実データ(ピーク比)と既定曲線を、実データの件数に応じた重みで混ぜる
  const k = total / (total + PRIOR_WEIGHT_MESSAGES);
  return DEFAULT_CURVE.map((d, h) => Math.max(MIN_WEIGHT, (1 - k) * d + k * (peakCount ? counts[h] / peakCount : 0)));
}

// 今この時間帯に実行するか(間引き法)
function activeNow(guildId, now = new Date()) {
  return Math.random() < hourWeights(guildId)[Math.floor(hourOfDayJST(now))];
}

// 平均meanMsの指数分布の待ち時間
function exponentialDelay(meanMs) {
  const d = -Math.log(1 - Math.random()) * meanMs;
  return Math.round(Math.min(MAX_DELAY_RATIO * meanMs, Math.max(MIN_DELAY_RATIO * meanMs, d)));
}

// scheduleWithJitterの代わり。fnは毎回の起床時に呼ばれ、実行するかどうかは
// fn側でactiveNow/waitingForReplyを見て決める(チャンネル・サーバーはfn側でしか分からないため)
function scheduleHumanLike(meanMs, fn) {
  async function tick() {
    try {
      await fn();
    } catch (err) {
      logger.error('SCHEDULER', err);
    } finally {
      setTimeout(tick, exponentialDelay(meanMs)).unref?.();
    }
  }
  setTimeout(tick, exponentialDelay(meanMs)).unref?.();
}

// チャンネルの最後の発言が自分たち(運用中のどれかのアカウント)の発言で、その後に人間が
// 何も書いていなければtrue。誰も反応していない所に重ねて書かないための判定。
// 受信済みのメッセージキャッシュだけを見る(Discord APIは呼ばない)。キャッシュが空なら判定しない
function waitingForReply(channel, now = Date.now()) {
  const msgs = [...(channel?.messages?.cache?.values() || [])].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const last = msgs[0];
  if (!last || !isOwnAccount(last.author.id)) return false;
  return now - last.createdTimestamp < UNANSWERED_RETRY_MS;
}

module.exports = { scheduleHumanLike, activeNow, waitingForReply, hourWeights, exponentialDelay, DEFAULT_CURVE };
