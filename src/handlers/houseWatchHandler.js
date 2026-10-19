const config = require('../utils/config');
const logger = require('../utils/logger');
const store = require('../utils/houseWatchStore');
const { fetchSubjects, fetchFirstPost, threadUrl } = require('../utils/fivechApi');
const { scheduleWithJitter } = require('../utils/scheduler');
const { getAllClients } = require('../utils/accountRegistry');

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
// read.cgiのHTMLならclass="uid"のspanにIDが入る(ID非表示ならspanが空か無い)。ID:???は非表示扱い
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

// 投稿役の候補。houseWatch.accountOrder(アカウントIDの配列)があればその順、無ければアカウント番号順で、
// ログイン済み・ロックダウン中でない・通知先チャンネルが見えるアカウントだけを返す。
// アカウント1が落ちていても他(待機)アカウントが代わりに投稿できるようにするため
function posterCandidates(channelId) {
  const all = getAllClients();
  const order = config.houseWatch?.accountOrder;
  const ordered = Array.isArray(order) && order.length > 0
    ? order.map((id) => all.find((c) => c.accountState?.id === String(id))).filter(Boolean)
    : all;
  return ordered
    .filter((c) => c.isReady?.() && !c.accountState?.lockedDown)
    .map((c) => ({ client: c, channel: c.channels?.cache.get(channelId) }))
    .filter((p) => p.channel);
}

// 候補の先頭から送信を試み、失敗したら次のアカウントで送り直す
async function sendWithFallback(channelId, content, t) {
  for (const { client, channel } of posterCandidates(channelId)) {
    try {
      await channel.send(content);
      logger.log('HOUSE', `[${client.accountState.id}] ${t.key} ${t.title}`);
      return true;
    } catch (err) {
      logger.error('HOUSE', `[${client.accountState.id}] 送信失敗、次のアカウントで再試行: ${err.message}`);
    }
  }
  logger.error('HOUSE', `全アカウントで送信失敗: ${t.key} ${t.title}`);
  return false;
}

// スレタイにkeyword(既定🏡)を含み、かつID非表示(!extend:none:...)の新スレを通知する。
// >>1の取得はタイトル一致したスレだけに限定して余計なアクセスを避ける。
// requireIdHidden=falseにするとID判定を省きタイトル一致だけで通知する
async function checkOnce({ manual = false } = {}) {
  const channelId = store.getChannelId();
  if (!channelId) return { found: [], error: '通知先チャンネル未設定' };
  if (posterCandidates(channelId).length === 0) {
    return { found: [], error: '通知先チャンネルに投稿できるアカウントが無い(全アカウント未ログイン/ロックダウン中/チャンネル不可視)' };
  }

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
      found.push(t);
      continue;
    }
    const html = await fetchFirstPost(boardUrl, t.key);
    // 取得失敗は判定保留(seenに入れず次回再試行)。judgedは該当しなかったスレ
    if (html !== null) {
      if (isIdHidden(html, extendIdMode)) found.push(t);
      else judged.push(t.key);
    }
    await sleep(firstPostDelayMs);
  }

  store.markSeen(judged);

  // 該当スレは送信に成功した時だけ通知済みにする(全アカウントで送信失敗したら次回再送)
  for (const t of found) {
    if (await sendWithFallback(channelId, `🏡 お🏡スレ検知\n**${t.title}** (${t.resCount})\n${threadUrl(boardUrl, t.key)}`, t)) {
      store.markSeen([t.key]);
    }
  }

  if (manual) logger.log('HOUSE', `手動チェック: 候補${candidates.length}件 / 通知${found.length}件`);
  return { found, candidates: candidates.length };
}

// アカウント非依存の全体機能なので監視ループは1本だけ回し、投稿役は投稿の都度
// posterCandidatesで選ぶ(アカウント1固定だとそのアカウントが落ちた時に通知が止まるため)
function registerHouseWatchHandler(clients) {
  if (!config.houseWatch?.enabled) return;
  if (clients.length === 0) return;

  const { checkIntervalMs = 120000, checkIntervalJitter = 0.3 } = config.houseWatch;
  scheduleWithJitter(checkIntervalMs, checkIntervalJitter, () => checkOnce());
}

module.exports = { registerHouseWatchHandler, checkOnce, parseExtdat, isIdHidden };
