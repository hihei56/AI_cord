const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { todayJST } = require('./datetime');

// 自律エージェントの「どの行動が実際に人間の発言を増やしたか」の実測記録。
// 行動の種類(arm)ごとに、行動後evalWindowの間に増えた人間の発言数(報酬)の
// 件数・合計・二乗和を持つ。平均と標準誤差が出せるので、「話題振りは
// 何もしない(wait)より本当に効いているのか」を勘ではなく数字で判断できる。
// data/agent-stats-<accountId>.json に永続化する
function createEngagementStats(accountId) {
  const filePath = path.join(__dirname, '..', '..', 'data', `agent-stats-${accountId}.json`);

  let state;
  try {
    state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    state = {};
  }
  state.arms = state.arms || {};
  state.daily = state.daily || { date: todayJST(), actions: 0 };
  state.intervalMultiplier = state.intervalMultiplier || 1;

  let writeQueue = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(state, null, 2);
    writeQueue = writeQueue
      .then(() => fs.promises.mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => fs.promises.writeFile(filePath, snapshot))
      .catch((err) => logger.error('AGENT', err));
  }

  function rollDay() {
    const today = todayJST();
    if (state.daily.date !== today) state.daily = { date: today, actions: 0 };
  }

  // 「何かした時」全体と「何もしなかった時(wait)」の報酬を比べ、統計的に有意
  // (差の95%信頼区間が0をまたがない)な場合だけ行動間隔を調整する。
  // 何かすると逆に人間の発言が減っている → 間隔を1.5倍に伸ばして口数を減らす。
  // 有意に増えている → 間隔を縮める(ただし設定値より短くはしない)。
  // 差が誤差の範囲なら何もしない。人が設定を触らなくても、場を荒らしている時は勝手に静かになる
  function adaptInterval() {
    const wait = state.arms.wait;
    const acted = Object.entries(state.arms)
      .filter(([type]) => type !== 'wait')
      .reduce((acc, [, a]) => ({ n: acc.n + a.n, sum: acc.sum + a.sum, sumSq: acc.sumSq + a.sumSq }), { n: 0, sum: 0, sumSq: 0 });
    if (!wait || wait.n < MIN_N_WAIT || acted.n < MIN_N_ACTED) return;

    const w = meanSe(wait);
    const a = meanSe(acted);
    const diff = a.mean - w.mean;
    const se = Math.sqrt(a.se ** 2 + w.se ** 2);
    const before = state.intervalMultiplier;
    if (diff + 1.96 * se < 0) state.intervalMultiplier = Math.min(MAX_INTERVAL_MULTIPLIER, before * 1.5);
    else if (diff - 1.96 * se > 0) state.intervalMultiplier = Math.max(1, before / 1.5);
    if (state.intervalMultiplier !== before) {
      logger.log(
        'AGENT',
        `[${accountId}] 行動間隔の倍率を${before.toFixed(2)}→${state.intervalMultiplier.toFixed(2)}に調整 (行動時${a.mean.toFixed(2)} vs wait${w.mean.toFixed(2)}, 差${diff.toFixed(2)}±${(1.96 * se).toFixed(2)})`
      );
    }
  }

  return {
    actionsToday() {
      rollDay();
      return state.daily.actions;
    },

    countAction() {
      rollDay();
      state.daily.actions++;
      save();
    },

    addResult(type, reward) {
      const arm = (state.arms[type] = state.arms[type] || { n: 0, sum: 0, sumSq: 0 });
      arm.n++;
      arm.sum += reward;
      arm.sumSq += reward * reward;
      adaptInterval();
      save();
    },

    // 候補の中から、各行動の報酬の事後分布(正規近似)から1回ずつ値を引いて最大のものを選ぶ
    // (トンプソン抽出)。実測で効果の高い行動ほど選ばれやすく、データの少ない行動は
    // 不確かさが大きい分たまに高い値を引いて試される。探索率のような手動調整値が要らない
    thompsonPick(candidates) {
      const all = Object.values(state.arms);
      const totalN = all.reduce((a, x) => a + x.n, 0);
      const priorMean = totalN ? all.reduce((a, x) => a + x.sum, 0) / totalN : 1;
      let best = null;
      let bestSample = -Infinity;
      for (const type of candidates) {
        const { mean, sd } = posterior(state.arms[type], priorMean);
        const sample = mean + sd * gaussian();
        if (sample > bestSample) {
          bestSample = sample;
          best = type;
        }
      }
      return best;
    },

    // エージェントの行動間隔の倍率(1〜MAX_INTERVAL_MULTIPLIER)。adaptIntervalが自動で調整する
    intervalMultiplier() {
      return state.intervalMultiplier;
    },

    // { type: { n, mean, se } }。n<2の時はseを出さない(1件では散らばりが分からない)
    summary() {
      const out = {};
      for (const [type, { n, sum, sumSq }] of Object.entries(state.arms)) {
        const mean = n ? sum / n : 0;
        const variance = n > 1 ? (sumSq - n * mean * mean) / (n - 1) : null;
        out[type] = { n, mean, se: variance !== null ? Math.sqrt(Math.max(0, variance) / n) : null };
      }
      return out;
    }
  };
}

const MIN_N_WAIT = 10;
const MIN_N_ACTED = 20;
const MAX_INTERVAL_MULTIPLIER = 4;
// データが無い/1件しかない行動の事前分布の幅。報酬は「10分間の人間の発言数」で
// 普通は0〜数件なので、2あれば未知の行動が十分試される程度の不確かさになる
const PRIOR_SD = 2;

function meanSe({ n, sum, sumSq }) {
  const mean = n ? sum / n : 0;
  const variance = n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : PRIOR_SD ** 2;
  return { mean, se: Math.sqrt(variance / Math.max(n, 1)) };
}

// 行動の報酬平均の事後分布(正規近似)。2件未満なら全行動の平均を中心にした広い事前分布
function posterior(arm, priorMean) {
  if (!arm || arm.n < 2) return { mean: arm?.n ? (arm.sum + priorMean) / 2 : priorMean, sd: PRIOR_SD };
  const { mean, se } = meanSe(arm);
  return { mean, sd: Math.max(se, 0.05) };
}

// 標準正規乱数(Box-Muller)
function gaussian() {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 「何もしない(wait)と比べてどれだけ人間の発言が増えたか」をLLMに渡す/コマンドで
// 表示する用の1行テキスト。サンプルが少ないうちは差が誤差の範囲だと明示する
function formatSummary(summary) {
  const base = summary.wait;
  const lines = Object.entries(summary)
    .sort((a, b) => b[1].mean - a[1].mean)
    .map(([type, { n, mean, se }]) => {
      const lift = base && type !== 'wait' ? ` (waitとの差 ${mean - base.mean >= 0 ? '+' : ''}${(mean - base.mean).toFixed(2)})` : '';
      const err = se !== null ? ` ±${se.toFixed(2)}` : '';
      const note = n < 5 ? ' ※n<5で参考外' : '';
      return `${type}: 平均${mean.toFixed(2)}件${err} n=${n}${lift}${note}`;
    });
  return lines.length ? lines.join('\n') : '(まだ記録なし)';
}

module.exports = { createEngagementStats, formatSummary };
