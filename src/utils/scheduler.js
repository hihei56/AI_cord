// setIntervalは常に寸分違わず同じ周期で発火するため、投稿タイミングが機械的な
// パターンとして見えやすい(AI/botバレの原因になる)。代わりに、次回までの待機時間を
// 呼び出すたびにランダムに決めてsetTimeoutを繰り返すことで、人間の投稿頻度のような
// ばらつきを持たせる。
//
// baseMs: 基準となる間隔(ms)。jitterRatio: ±の振れ幅の割合(0.4なら基準値の60%〜140%の間でばらつく)
function nextDelay(baseMs, jitterRatio) {
  const jitter = baseMs * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(1000, Math.round(baseMs + jitter));
}

function scheduleWithJitter(baseMs, jitterRatio, fn) {
  async function tick() {
    try {
      await fn();
    } catch {
      // fn側で必要なログは出している前提。ここで握りつぶさないとunhandledRejectionで
      // スケジュールが止まりかねないため
    } finally {
      setTimeout(tick, nextDelay(baseMs, jitterRatio));
    }
  }

  setTimeout(tick, nextDelay(baseMs, jitterRatio));
}

module.exports = { scheduleWithJitter, nextDelay };
