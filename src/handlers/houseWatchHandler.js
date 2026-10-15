const config = require('../utils/config');
const logger = require('../utils/logger');
const store = require('../utils/houseWatchStore');
const { fetchSubjects, fetchFirstPost, threadUrl } = require('../utils/fivechApi');
const { scheduleWithJitter } = require('../utils/scheduler');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// >>1のEXTDAT表記からID表示設定(先頭フィールド)を取り出す。
// !extend:none:none:1000:512 → "none:none:1000:512"
function parseExtdat(html) {
  const m = html.match(/VIPQ2_EXTDAT:\s*([^:\s<]+):([^:\s<]+):(\d+):(\d+)/);
  return m ? { id: m[1], slip: m[2], maxRes: Number(m[3]), maxKb: Number(m[4]) } : null;
}

// スレタイにkeyword(既定🏡)を含み、かつ>>1のEXTDATでIDがextendIdMode(既定none=ID非表示)の
// 新スレだけを通知する。>>1の取得はタイトル一致したスレだけに絞って余計なアクセスを避ける
async function checkOnce(client, { manual = false } = {}) {
  const channelId = store.getChannelId();
  if (!channelId) return { found: [], error: '通知先チャンネル未設定' };
  const channel = client.channels?.cache.get(channelId);
  if (!channel) return { found: [], error: '通知先チャンネルが見つからない' };

  const { boardUrl, keyword = '🏡', extendIdMode = 'none', firstPostDelayMs = 1500 } = config.houseWatch || {};

  let threads;
  try {
    threads = await fetchSubjects(boardUrl);
  } catch (err) {
    logger.error('HOUSE', err);
    return { found: [], error: err.message };
  }

  const candidates = threads.filter((t) => t.title.includes(keyword) && !store.hasSeen(t.key));
  const found = [];
  const judged = [];

  for (const t of candidates) {
    const html = await fetchFirstPost(boardUrl, t.key);
    // 取得失敗は判定保留(seenに入れず次回再試行)
    if (html !== null) {
      judged.push(t.key);
      const ext = parseExtdat(html);
      if (ext && ext.id === extendIdMode) found.push({ ...t, ext });
    }
    await sleep(firstPostDelayMs);
  }

  store.markSeen(judged);

  for (const t of found) {
    try {
      await channel.send(`🏡 お🏡スレ検知\n**${t.title}** (${t.resCount})\n${threadUrl(boardUrl, t.key)}`);
      logger.log('HOUSE', `${t.key} ${t.title}`);
    } catch (err) {
      logger.error('HOUSE', err);
    }
  }

  if (manual) logger.log('HOUSE', `手動チェック: 候補${candidates.length}件 / 通知${found.length}件`);
  return { found, candidates: candidates.length };
}

// 価格アラートと同じくアカウント非依存の全体機能なので、clients[0]だけが投稿を担当する
function registerHouseWatchHandler(clients) {
  if (!config.houseWatch?.enabled) return;
  const client = clients[0];
  if (!client) return;

  const { checkIntervalMs = 120000, checkIntervalJitter = 0.3 } = config.houseWatch;
  scheduleWithJitter(checkIntervalMs, checkIntervalJitter, () => checkOnce(client));
}

module.exports = { registerHouseWatchHandler, checkOnce, parseExtdat };
