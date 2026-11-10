const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const { todayJST, hourOfDayJST } = require('./datetime');

// サーバー活性化コーチ(serverCoachHandler)用の統計収集。
// 既に受信しているmessageCreateイベントを数えるだけで、履歴の追加fetch等の
// Discord API呼び出しはしない(セルフボットで大量のfetchはbot判定の材料になるため)。
//
// 個人を特定・評価する用途ではなく「サーバー全体の状態」を見るためのものなので、
// ユーザーIDはサーバーごとのランダムなsaltでハッシュ化して保存する(定着率や
// 新規参加者の追跡に「同じ人か」は必要だが、「誰か」は不要)。
// 保存先: data/server-stats-<guildId>.json(直近KEEP_DAYS日分の日別集計)
const KEEP_DAYS = 35;
const NEWCOMER_REPLY_WINDOW_MS = 30 * 60000;
const NEWCOMER_TRACK_DAYS = 7;

const stores = new Map();

function storePath(guildId) {
  return path.join(__dirname, '..', '..', 'data', `server-stats-${guildId}.json`);
}

function loadStore(guildId) {
  if (stores.has(guildId)) return stores.get(guildId);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(storePath(guildId), 'utf-8'));
  } catch {
    state = {};
  }
  state.salt = state.salt || crypto.randomBytes(16).toString('hex');
  state.days = state.days || {};
  // 参加した人(ハッシュ) → { joinedAt, firstMsgAt, responded }
  state.newcomers = state.newcomers || {};
  const store = { state, dirty: false, pendingFirst: [] };
  stores.set(guildId, store);
  return store;
}

function hashUser(store, userId) {
  return crypto.createHash('sha256').update(store.state.salt + userId).digest('hex').slice(0, 12);
}

function dayBucket(store, date = todayJST()) {
  const d = (store.state.days[date] = store.state.days[date] || {
    human: 0,
    own: 0,
    replies: 0,
    channels: {},
    hours: Array(24).fill(0),
    authors: {},
    joins: 0
  });
  return d;
}

function prune(store) {
  const dates = Object.keys(store.state.days).sort();
  while (dates.length > KEEP_DAYS) delete store.state.days[dates.shift()];
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const [h, n] of Object.entries(store.state.newcomers)) {
    if (n.joinedAt < cutoff) delete store.state.newcomers[h];
  }
}

// 同じメッセージを複数アカウントのclientが受信するので、メッセージIDで重複を除く
const seen = new Set();
const SEEN_MAX = 5000;

// isOwn: 自分たちのアカウント(AI)の発言か。isHuman: 実在ユーザーの発言か
function recordMessage(msg, { isOwn, isHuman }) {
  if (!msg.guild || seen.has(msg.id)) return;
  seen.add(msg.id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);

  const store = loadStore(msg.guild.id);
  const d = dayBucket(store);
  const now = Date.now();

  if (msg.type === 'GUILD_MEMBER_JOIN') {
    d.joins++;
    store.state.newcomers[hashUser(store, msg.author.id)] = { joinedAt: now, firstMsgAt: null, responded: false };
    store.dirty = true;
    return;
  }

  // 新規参加者の最初の発言のあと、別の誰か(AI含む)が同じチャンネルで反応したか
  store.pendingFirst = store.pendingFirst.filter((p) => now - p.at < NEWCOMER_REPLY_WINDOW_MS);
  for (const p of store.pendingFirst) {
    if (p.channelId === msg.channel.id && p.authorId !== msg.author.id && store.state.newcomers[p.hash]) {
      store.state.newcomers[p.hash].responded = true;
    }
  }

  if (isOwn) {
    d.own++;
  } else if (isHuman) {
    const h = hashUser(store, msg.author.id);
    d.human++;
    d.channels[msg.channel.id] = (d.channels[msg.channel.id] || 0) + 1;
    d.hours[Math.floor(hourOfDayJST())]++;
    d.authors[h] = (d.authors[h] || 0) + 1;
    if (msg.type === 'REPLY' && msg.mentions?.repliedUser && msg.mentions.repliedUser.id !== msg.author.id) d.replies++;

    const nc = store.state.newcomers[h];
    if (nc && !nc.firstMsgAt && now - nc.joinedAt < NEWCOMER_TRACK_DAYS * 86400000) {
      nc.firstMsgAt = now;
      store.pendingFirst.push({ hash: h, authorId: msg.author.id, channelId: msg.channel.id, at: now });
    }
  } else {
    return;
  }
  store.dirty = true;
}

function flushAll() {
  for (const [guildId, store] of stores) {
    if (!store.dirty) continue;
    prune(store);
    store.dirty = false;
    fs.promises
      .mkdir(path.dirname(storePath(guildId)), { recursive: true })
      .then(() => fs.promises.writeFile(storePath(guildId), JSON.stringify(store.state)))
      .catch((err) => logger.error('COACH', err));
  }
}
setInterval(flushAll, 60000).unref();

function datesBack(from, count) {
  const out = [];
  for (let i = from; i < from + count; i++) out.push(todayJST(new Date(Date.now() - i * 86400000)));
  return out;
}

// 期間(日付リスト)の集計
function aggregate(store, dates) {
  const agg = { days: 0, human: 0, own: 0, replies: 0, joins: 0, channels: {}, hours: Array(24).fill(0), authors: {}, dailyActive: [] };
  for (const date of dates) {
    const d = store.state.days[date];
    if (!d) continue;
    agg.days++;
    agg.human += d.human;
    agg.own += d.own;
    agg.replies += d.replies;
    agg.joins += d.joins;
    for (const [c, n] of Object.entries(d.channels)) agg.channels[c] = (agg.channels[c] || 0) + n;
    d.hours.forEach((n, i) => (agg.hours[i] += n));
    for (const [a, n] of Object.entries(d.authors)) agg.authors[a] = (agg.authors[a] || 0) + n;
    agg.dailyActive.push(Object.keys(d.authors).length);
  }
  return agg;
}

// 直近7日と、その前の7日を比較した指標を返す。データが足りなければ null
function computeMetrics(guildId) {
  const store = loadStore(guildId);
  const cur = aggregate(store, datesBack(0, 7));
  const prev = aggregate(store, datesBack(7, 7));
  if (cur.days === 0) return null;

  const counts = Object.values(cur.authors).sort((a, b) => b - a);
  const top3Share = cur.human ? counts.slice(0, 3).reduce((a, b) => a + b, 0) / cur.human : 0;
  const prevAuthors = Object.keys(prev.authors);
  const retained = prevAuthors.filter((a) => cur.authors[a]).length;

  const newcomers = Object.values(store.state.newcomers).filter((n) => Date.now() - n.joinedAt < 14 * 86400000);
  const matured = newcomers.filter((n) => Date.now() - n.joinedAt > NEWCOMER_TRACK_DAYS * 86400000 || n.firstMsgAt);
  const posted = matured.filter((n) => n.firstMsgAt);

  return {
    daysCovered: cur.days,
    prevDaysCovered: prev.days,
    messagesPerDay: cur.human / cur.days,
    prevMessagesPerDay: prev.days ? prev.human / prev.days : null,
    avgDailyActive: cur.dailyActive.reduce((a, b) => a + b, 0) / cur.days,
    weeklyActive: counts.length,
    prevWeeklyActive: prev.days ? prevAuthors.length : null,
    retention: prevAuthors.length ? retained / prevAuthors.length : null,
    top3Share,
    replyRate: cur.human ? cur.replies / cur.human : 0,
    aiShare: cur.human + cur.own ? cur.own / (cur.human + cur.own) : 0,
    joins: cur.joins,
    newcomerPostRate: matured.length ? posted.length / matured.length : null,
    newcomerRespondedRate: posted.length ? posted.filter((n) => n.responded).length / posted.length : null,
    newcomerSample: matured.length,
    channels: cur.channels,
    hours: cur.hours
  };
}

module.exports = { recordMessage, computeMetrics, flushAll };
