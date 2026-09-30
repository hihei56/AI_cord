const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'daily-bump.json');

// !slashbump mode <botId> dailyで「1日1回だけ、日中活動時間帯からランダムな時刻に
// 実行する」モードにした対象向けの状態。mealPostStore.jsと同じ考え方で、その日の
// 実行予定時刻(分単位小数、JST)は一度決めたら日付が変わるまで固定し(判定のたびに
// 抽選し直すと「予定時刻を過ぎたか」を正しく判定できないため)、最後に実行した日付と
// あわせて永続化する(再起動を挟んでも同じ日なら予定時刻がブレない・二重実行しない)
function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return { lastRunDate: {}, todayTarget: {} };
  }
}

const state = load();
state.lastRunDate = state.lastRunDate || {};
state.todayTarget = state.todayTarget || {};

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

function getLastRunDate(key) {
  return state.lastRunDate[key] || null;
}

function setLastRunDate(key, dateStr) {
  state.lastRunDate[key] = dateStr;
  save();
}

function getTodayTarget(key, dateStr) {
  const entry = state.todayTarget[key];
  if (!entry || entry.date !== dateStr) return null;
  return entry.hourOfDay;
}

function setTodayTarget(key, dateStr, hourOfDay) {
  state.todayTarget[key] = { date: dateStr, hourOfDay };
  save();
}

module.exports = { getLastRunDate, setLastRunDate, getTodayTarget, setTodayTarget };
