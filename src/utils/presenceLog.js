const fs = require('fs');
const path = require('path');

// 直近3か月分だけ残す(それより古い記録は読み書きのたびに切り捨てる)
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const TRACKED_FILE = path.join(DATA_DIR, 'tracked-presence-users.json');

function logPath(userId) {
  return path.join(DATA_DIR, `presence-log-${userId}.json`);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadTracked() {
  return readJson(TRACKED_FILE, []);
}

function isTracked(userId) {
  return loadTracked().includes(userId);
}

function addTracked(userId) {
  const list = loadTracked();
  if (list.includes(userId)) return false;
  list.push(userId);
  writeJson(TRACKED_FILE, list);
  return true;
}

function removeTracked(userId) {
  const list = loadTracked();
  if (!list.includes(userId)) return false;
  writeJson(TRACKED_FILE, list.filter((id) => id !== userId));
  return true;
}

function pruneOld(entries) {
  const cutoff = Date.now() - RETENTION_MS;
  return entries.filter((e) => e.timestamp >= cutoff);
}

// 直前の記録と同じステータスなら記録しない(状態が変わった時だけ残す)。
// 複数アカウントが同じユーザーのpresenceUpdateを見ても、変化がなければ重複しない。
function recordStatus(userId, status) {
  const entries = pruneOld(readJson(logPath(userId), []));
  const last = entries[entries.length - 1];
  if (last && last.status === status) return;
  entries.push({ status, timestamp: Date.now() });
  writeJson(logPath(userId), entries);
}

function getLog(userId) {
  return pruneOld(readJson(logPath(userId), []));
}

module.exports = { loadTracked, isTracked, addTracked, removeTracked, recordStatus, getLog, RETENTION_MS };
