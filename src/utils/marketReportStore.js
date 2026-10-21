const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'market-report.json');

// 市況レポートの投稿先チャンネル・最後にチェックした日(日本時間)・最後に投稿した
// 米国の取引日を data/market-report.json に永続化する。取引日で判定することで、
// 土日祝(米国休場)の翌朝は同じ内容を二重投稿しない
function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return { channelId: null, lastCheckedDate: null, lastReportedTradingDay: null };
  }
}

const state = load();

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

module.exports = {
  getChannelId: () => state.channelId,
  setChannelId(channelId) {
    state.channelId = channelId;
    save();
  },
  getLastCheckedDate: () => state.lastCheckedDate,
  setLastCheckedDate(dateStr) {
    state.lastCheckedDate = dateStr;
    save();
  },
  getLastReportedTradingDay: () => state.lastReportedTradingDay,
  setLastReportedTradingDay(dateStr) {
    state.lastReportedTradingDay = dateStr;
    save();
  }
};
