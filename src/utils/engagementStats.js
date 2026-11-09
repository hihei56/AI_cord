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
      save();
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
