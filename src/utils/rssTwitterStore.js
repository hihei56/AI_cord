const fs = require('fs');
const path = require('path');

// アカウントごとに、投稿済み(または既読扱いにした)ツイートのguid/linkを
// data/rss-twitter-seen-<id>.json に永続化する。再起動のたびにフィードの
// 全履歴を再投稿してしまわないようにするため
const SEEN_MAX = 500;

function storePathFor(accountId) {
  return path.join(__dirname, '..', '..', 'data', `rss-twitter-seen-${accountId}.json`);
}

function load(accountId) {
  try {
    return JSON.parse(fs.readFileSync(storePathFor(accountId), 'utf-8'));
  } catch {
    return { seen: [] };
  }
}

function save(accountId, state) {
  const dir = path.dirname(storePathFor(accountId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(storePathFor(accountId), JSON.stringify(state, null, 2));
}

// isFirstRun: 保存ファイルが無い(＝一度もチェックしたことが無い)状態かどうか。
// 初回起動時にフィードの既存アイテムを全部「新着」として一気に投稿しないよう、
// 呼び出し側で「初回は投稿せず既読登録だけする」判定に使う
function createSeenTracker(accountId) {
  const state = load(accountId);
  state.seen = state.seen || [];
  const seenSet = new Set(state.seen);

  return {
    isFirstRun: state.seen.length === 0,
    has(key) {
      return seenSet.has(key);
    },
    add(key) {
      if (!key || seenSet.has(key)) return;
      seenSet.add(key);
      state.seen.push(key);
      if (state.seen.length > SEEN_MAX) {
        const removed = state.seen.shift();
        seenSet.delete(removed);
      }
      save(accountId, state);
    }
  };
}

module.exports = { createSeenTracker };
