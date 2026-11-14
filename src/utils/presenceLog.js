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

// presenceUpdateは全サーバーの全メンバーのステータス変化ごと(×アカウント数)に発火する。
// 以前はそのたびに追跡対象ファイルを同期読み込み+JSON解析していて、イベントループを
// 塞いでいた。追跡対象はメモリに持ち、変更時だけファイルに書く
let trackedCache = null;

function trackedSet() {
  if (!trackedCache) trackedCache = new Set(readJson(TRACKED_FILE, []));
  return trackedCache;
}

function loadTracked() {
  return [...trackedSet()];
}

function isTracked(userId) {
  return trackedSet().has(userId);
}

function addTracked(userId) {
  const set = trackedSet();
  if (set.has(userId)) return false;
  set.add(userId);
  writeJson(TRACKED_FILE, [...set]);
  return true;
}

function removeTracked(userId) {
  const set = trackedSet();
  if (!set.delete(userId)) return false;
  writeJson(TRACKED_FILE, [...set]);
  return true;
}

function pruneOld(entries) {
  const cutoff = Date.now() - RETENTION_MS;
  return entries.filter((e) => e.timestamp >= cutoff);
}

// 直前の記録と同じステータスなら記録しない(状態が変わった時だけ残す)。
// 複数アカウントが同じユーザーのpresenceUpdateを見ても、変化がなければ重複しない。
// 直前のステータスはメモリにも持ち、変化が無い時(同じイベントを複数アカウントが受信した時を含む)は
// ファイルを読みに行かない
const lastStatus = new Map();

function recordStatus(userId, status) {
  if (lastStatus.get(userId) === status) return;
  const entries = pruneOld(readJson(logPath(userId), []));
  const last = entries[entries.length - 1];
  lastStatus.set(userId, status);
  if (last && last.status === status) return;
  entries.push({ status, timestamp: Date.now() });
  writeJson(logPath(userId), entries);
}

function getLog(userId) {
  return pruneOld(readJson(logPath(userId), []));
}

module.exports = { loadTracked, isTracked, addTracked, removeTracked, recordStatus, getLog, RETENTION_MS };
