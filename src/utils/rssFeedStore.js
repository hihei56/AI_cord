const fs = require('fs');
const path = require('path');

// RSS(nitter等)からのツイートリンク自動投稿(rssTwitterPost)の設定
// (フィードURL一覧・投稿先チャンネル・有効/無効)をアカウントごとに
// data/rss-feed-<accountId>.jsonへ永続化する。.envのRSS_FEED_URL[_N]/
// RSS_POST_CHANNEL_ID[_N]は初回起動時の初期値としてのみ使い、以降は
// !rssfeedコマンドで再起動不要に変更できるようにするため
function storePath(accountId) {
  return path.join(__dirname, '..', '..', 'data', `rss-feed-${accountId}.json`);
}

function load(accountId) {
  try {
    return JSON.parse(fs.readFileSync(storePath(accountId), 'utf-8'));
  } catch {
    return null;
  }
}

function save(accountId, state) {
  const filePath = storePath(accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function loadOrInit(accountId, defaults) {
  const existing = load(accountId);
  if (existing) return existing;
  save(accountId, defaults);
  return { ...defaults };
}

// state(accountState.rssFeedと同じ参照)をその場で書き換えて保存する。こうすることで
// 既にstateを読んでいるrssTwitterPostHandler.js側は何も変更せず変更をすぐ反映できる
function addFeedUrl(accountId, state, url) {
  if (state.feedUrls.includes(url)) return false;
  state.feedUrls.push(url);
  save(accountId, state);
  return true;
}

function removeFeedUrl(accountId, state, url) {
  const idx = state.feedUrls.indexOf(url);
  if (idx === -1) return false;
  state.feedUrls.splice(idx, 1);
  save(accountId, state);
  return true;
}

function setPostChannel(accountId, state, channelId) {
  state.postChannelId = channelId;
  save(accountId, state);
  return state;
}

function setEnabled(accountId, state, enabled) {
  state.enabled = enabled;
  save(accountId, state);
  return state;
}

module.exports = { loadOrInit, addFeedUrl, removeFeedUrl, setPostChannel, setEnabled };
