const config = require('../utils/config');
const logger = require('../utils/logger');
const store = require('../utils/houseWatchStore');
const { fetchSubjects, fetchFirstPost, threadUrl } = require('../utils/fivechApi');
const { scheduleWithJitter } = require('../utils/scheduler');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// >>1のEXTDAT表記からID表示設定(先頭フィールド)を取り出す。5ch wiki(新生VIPQ2)の仕様では
// 第1指定値がID(default/none/checked)、第2指定値がSLIP(空も可。例 !extend:none::1000:512)で、
// スレ立て後>>1末尾に「VIPQ2_EXTDAT: none:none:1000:512:: EXT was configured」が付く
function parseExtdat(html) {
  const m = html.match(/VIPQ2_EXTDAT:\s*([^:\s<]*):([^:\s<]*):(\d+):(\d+)/);
  return m ? { id: m[1], slip: m[2], maxRes: Number(m[3]), maxKb: Number(m[4]) } : null;
}

// >>1にIDが表示されているか。datは「名前<>E-mail<>日付とIDとBE<>本文<>スレタイ」
// (5ch wiki Monazilla/develop/dat)で、IDは日付欄に「 ID:xxx」として付き、無い時は日付だけになる。
// read.cgiのHTMLならclass="uid"のspanにIDが入る。ID:???は非表示扱い
function hasVisibleId(firstPost) {
  const idPattern = /ID:(?!\?\?\?)\S+/;
  if (firstPost.includes('<>')) {
    const dateField = firstPost.split('<>')[2] || '';
    return idPattern.test(dateField);
  }
  const uid = firstPost.match(/class="uid"[^>]*>([^<]*)/);
  return Boolean(uid && idPattern.test(uid[1]));
}

// ID非表示か判定する。EXTDAT表記があればそのID欄で決め、無ければ>>1にIDが出ていないかで決める
function isIdHidden(firstPost, extendIdMode) {
  const ext = parseExtdat(firstPost);
  if (ext) return ext.id === extendIdMode;
  return !hasVisibleId(firstPost);
}

// スレタイにkeyword(既定🏡)を含み、かつID非表示(!extend:none:...)の新スレを通知する。
// >>1の取得はタイトル一致したスレだけに限定して余計なアクセスを避ける。
// requireIdHidden=falseにするとID判定を省きタイトル一致だけで通知する
async function checkOnce(client, { manual = false } = {}) {
  const channelId = store.getChannelId();
  if (!channelId) return { found: [], error: '通知先チャンネル未設定' };
  const channel = client.channels?.cache.get(channelId);
  if (!channel) return { found: [], error: '通知先チャンネルが見つからない' };

  const {
    boardUrl,
    keyword = '🏡',
    requireIdHidden = true,
    extendIdMode = 'none',
    firstPostDelayMs = 1500
  } = config.houseWatch || {};

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
    if (!requireIdHidden) {
      judged.push(t.key);
      found.push(t);
      continue;
    }
    const html = await fetchFirstPost(boardUrl, t.key);
    // 取得失敗は判定保留(seenに入れず次回再試行)
    if (html !== null) {
      judged.push(t.key);
      if (isIdHidden(html, extendIdMode)) found.push(t);
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

module.exports = { registerHouseWatchHandler, checkOnce, parseExtdat, isIdHidden };
