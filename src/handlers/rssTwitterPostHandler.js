const config = require('../utils/config');
const logger = require('../utils/logger');
const { scheduleWithJitter } = require('../utils/scheduler');
const { createSeenTracker } = require('../utils/rssTwitterStore');
const { toVxTwitterUrl } = require('../utils/vxtwitter');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postDelay() {
  const { postDelayMs = 4000, postDelayJitter = 0.4 } = config.rssTwitterPost || {};
  return Math.max(0, postDelayMs * (1 + (Math.random() * 2 - 1) * postDelayJitter));
}

// newsTopics.jsと同じ簡易XML抽出方式。<item>ブロックごとにlink/guid/titleを拾う
function parseItems(xml) {
  const clean = (s) => (s ? s.replace('<![CDATA[', '').replace(']]>', '').trim() : null);
  return xml
    .split('<item>')
    .slice(1)
    .map((block) => block.split('</item>')[0])
    .map((block) => {
      const link = block.match(/<link>([\s\S]*?)<\/link>/);
      const guid = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/);
      const title = block.match(/<title>([\s\S]*?)<\/title>/);
      return {
        link: clean(link?.[1]),
        guid: clean(guid?.[1]),
        title: clean(title?.[1])
      };
    });
}

// User-Agent無指定だと弾く(403/接続拒否になる)Nitterミラーがあるため、
// ブラウザからのアクセスに見えるようUser-Agentを付ける
async function fetchItems(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const xml = await res.text();
  return parseItems(xml);
}

// 複数ミラーを順番に試し、最初に成功したものを使う(1つのNitterミラーが落ちて
// いても他のミラーで拾えるようにするため。個別サーバーを別途プロキシとして
// 立てる必要が無いよう、このフォールバック自体をBot側に持たせている)
async function fetchItemsWithFallback(feedUrls) {
  const errors = [];
  for (const feedUrl of feedUrls) {
    try {
      return await fetchItems(feedUrl);
    } catch (err) {
      errors.push(`${feedUrl}: ${err.message}`);
    }
  }
  throw new Error(`全ミラーで取得失敗 - ${errors.join(' / ')}`);
}

function itemKey(item) {
  return item.guid || item.link;
}

async function checkOnce(client, account) {
  const items = await fetchItemsWithFallback(account.rssFeedUrls);
  const tracker = account.seenTracker;

  const fresh = items.filter((item) => {
    const key = itemKey(item);
    return key && !tracker.has(key);
  });
  if (fresh.length === 0) return;

  // 初回チェック時はフィードの既存アイテムを全部「新着」扱いで一気に投稿しないよう、
  // 既読登録だけして投稿はしない(次回以降の本当の新着だけを追いかける)
  if (tracker.isFirstRun) {
    for (const item of fresh) tracker.add(itemKey(item));
    tracker.isFirstRun = false;
    logger.log('RSSTWITTER', `[${account.id}] 初回チェックのため既存${fresh.length}件を既読登録(投稿はスキップ)`);
    return;
  }

  const channel = client.channels?.cache.get(account.rssPostChannelId);
  if (!channel) {
    logger.error('RSSTWITTER', `[${account.id}] 投稿先チャンネル${account.rssPostChannelId}にアクセスできません`);
    return;
  }

  // フィードは新しい順のことが多いので、時系列順に投稿されるよう古い方から処理する
  for (const item of fresh.reverse()) {
    tracker.add(itemKey(item));

    const vxUrl = toVxTwitterUrl(item.link);
    if (!vxUrl) {
      logger.log('RSSTWITTER', `[${account.id}] ツイートリンクの形式ではないためスキップ: ${item.link}`);
      continue;
    }

    try {
      await channel.send(vxUrl);
      logger.log('RSSTWITTER', `[${account.id}] 投稿: ${vxUrl}`);
    } catch (err) {
      logger.error('RSSTWITTER', `[${account.id}] 投稿失敗: ${err.message}`);
    }
    await sleep(postDelay());
  }
}

// RSS(nitter等)からツイートリンクを定期取得し、vxtwitter.comのURLに変換して
// 投稿する。rssFeedUrls/rssPostChannelIdを設定したアカウントだけが対象(オプトイン)
function registerRssTwitterPostHandler(clients) {
  for (const client of clients) {
    const account = client.accountState;
    if (!account?.rssFeedUrls?.length || !account?.rssPostChannelId) continue;

    account.seenTracker = createSeenTracker(account.id);

    const { checkIntervalMs = 600000, checkIntervalJitter = 0.3 } = config.rssTwitterPost || {};
    scheduleWithJitter(checkIntervalMs, checkIntervalJitter, () =>
      checkOnce(client, account).catch((err) => logger.error('RSSTWITTER', `[${account.id}] ${err.message}`))
    );

    logger.log('RSSTWITTER', `[${account.id}] 監視開始: [${account.rssFeedUrls.join(', ')}] → <#${account.rssPostChannelId}>`);
  }
}

module.exports = { registerRssTwitterPostHandler };
