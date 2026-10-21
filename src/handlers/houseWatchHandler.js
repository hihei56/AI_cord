const config = require('../utils/config');
const logger = require('../utils/logger');
const store = require('../utils/houseWatchStore');
const { fetchSubjects, fetchThreadHead, threadUrl } = require('../utils/fivechApi');
const { scheduleWithJitter } = require('../utils/scheduler');
const { getAllClients } = require('../utils/accountRegistry');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// スレがID非表示か判定する。実況Gでは!extend:none:none:1000:512で立てても>>1末尾に
// 「VIPQ2_EXTDAT: none:none:...」が付くだけで、>>2以降にはIDが出るスレが実在する(浪人以外は
// ID非表示にできない板設定のため)。>>1自身はどちらのスレでもIDが出ないので判定に使えない。
// そこで>>2以降(最大10レス)に1つでもIDが出ていれば「ID有り」とする。ID:???は非表示扱い。
// レスが>>1しか無い間は判定できないのでnullを返す(呼び出し側で保留)
const VISIBLE_ID = /ID:(?!\?\?\?)\S+/;

function isThreadIdHidden(posts) {
  const replies = posts.filter((p) => p.no >= 2).slice(0, 10);
  if (replies.length === 0) return null;
  return !replies.some((p) => VISIBLE_ID.test(p.id || ''));
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

// ID非表示の新スレのURLを通知する。keywordを設定した場合はスレタイにそれを含むスレだけに絞る(空なら全スレ)。
// スレ本体の取得はタイトル一致かつレスが2件以上付いたスレだけに限定して余計なアクセスを避ける。
// requireIdHidden=falseにするとID判定を省きタイトル一致だけで通知する
// 初回は一覧の全スレを判定するので数分かかる。その間に!housewatch nowや次の定期チェックが
// 重なると同じスレを二重に取得・通知してしまうため、同時に1つしか走らせない
let running = false;

async function checkOnce(opts = {}) {
  if (running) return { found: [], error: '前回のチェックがまだ実行中(初回は全スレ判定で数分かかる)' };
  running = true;
  try {
    return await checkOnceInner(opts);
  } finally {
    running = false;
  }
}

async function checkOnceInner({ manual = false } = {}) {
  const channelId = store.getChannelId();
  if (!channelId) return { found: [], error: '通知先チャンネル未設定' };
  if (posterCandidates(channelId).length === 0) {
    return { found: [], error: '通知先チャンネルに投稿できるアカウントが無い(全アカウント未ログイン/ロックダウン中/チャンネル不可視)' };
  }

  const {
    boardUrl,
    keyword = '',
    requireIdHidden = true,
    firstPostDelayMs = 1500
  } = config.houseWatch || {};
  // キーワード無し+ID判定無しだと板の全スレを通知してしまうので拒否する
  if (!keyword && !requireIdHidden) return { found: [], error: 'keyword空のままrequireIdHidden=falseにはできない(全スレ通知になる)' };

  let threads;
  try {
    threads = await fetchSubjects(boardUrl);
  } catch (err) {
    logger.error('HOUSE', err);
    return { found: [], error: err.message };
  }

  const candidates = threads.filter((t) => (!keyword || t.title.includes(keyword)) && !store.hasSeen(t.key));
  const found = [];
  const judged = [];

  for (const t of candidates) {
    if (!requireIdHidden) {
      found.push(t);
      continue;
    }
    // >>2が付くまではID有無を判定できないので、取得もせず保留(seenに入れず次回再チェック)
    if (t.resCount < 2) continue;
    let hidden = null;
    try {
      hidden = isThreadIdHidden((await fetchThreadHead(boardUrl, t.key)).posts);
    } catch (err) {
      logger.error('HOUSE', err);
    }
    // 取得失敗・判定不能は保留。judgedは該当しなかったスレ
    if (hidden === true) found.push(t);
    else if (hidden === false) judged.push(t.key);
    await sleep(firstPostDelayMs);
  }

  store.markSeen(judged);

  // 該当スレは送信に成功した時だけ通知済みにする(全アカウントで送信失敗したら次回再送)
  for (const t of found) {
    if (await sendWithFallback(channelId, threadUrl(boardUrl, t.key), t)) {
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

module.exports = { registerHouseWatchHandler, checkOnce, isThreadIdHidden };
