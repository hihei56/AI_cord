const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'meal-posts.json');

// 各食事(breakfast/lunch/dinner)ごとに「今日の投稿予定時刻(分単位小数)」と
// 「最後に投稿した日付」を data/meal-posts.json に永続化する。
// 予定時刻を毎回チェックのたびに乱数で決め直すと、判定するたびに結果が
// 変わってしまい正しく「その時刻を過ぎたか」を判定できないため、その日の
// 分だけ一度決めたら固定する(日付が変わったら再抽選する)。再起動を挟んでも
// 同じ日ならブレない・二重投稿しないようファイルに永続化している
function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return { lastPostedDate: {}, todayTarget: {} };
  }
}

const state = load();
state.lastPostedDate = state.lastPostedDate || {};
state.todayTarget = state.todayTarget || {};

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

function getLastPostedDate(mealKey) {
  return state.lastPostedDate[mealKey] || null;
}

function setLastPostedDate(mealKey, dateStr) {
  state.lastPostedDate[mealKey] = dateStr;
  save();
}

// その日のmealKeyの投稿予定時刻(分単位小数、日本時間)を返す。
// 今日分がまだ無ければnullを返す(呼び出し側でsetTodayTargetして決める)
function getTodayTarget(mealKey, dateStr) {
  const entry = state.todayTarget[mealKey];
  if (!entry || entry.date !== dateStr) return null;
  return entry.hourOfDay;
}

function setTodayTarget(mealKey, dateStr, hourOfDay) {
  state.todayTarget[mealKey] = { date: dateStr, hourOfDay };
  save();
}

module.exports = { getLastPostedDate, setLastPostedDate, getTodayTarget, setTodayTarget };
