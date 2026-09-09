const fs = require('fs');
const path = require('path');

function storePath(accountId) {
  return path.join(__dirname, '..', '..', 'data', `memory-${accountId}.json`);
}

// アカウントごとの長期記憶(ユーザーごとの特徴メモ、最近の話題)を
// data/memory-<accountId>.json に永続化する。
// 各ユーザーのnotesは「生のやり取りの断片」を溜めておき、一定件数溜まったら
// aiClient.js側で要約させて短い特徴メモに圧縮する(compressUserMemory)。
function createMemoryStore(accountId) {
  const filePath = storePath(accountId);

  function load() {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return { users: {}, topics: [] };
    }
  }

  const state = load();
  state.users = state.users || {};
  state.topics = state.topics || [];
  state.recentReplies = state.recentReplies || [];

  const MAX_RAW_NOTES = 8;
  const MAX_SUMMARY_NOTES = 6;
  const MAX_TOPICS = 12;
  const MAX_RECENT_REPLIES = 4;

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  function ensureUser(userId) {
    if (!state.users[userId]) state.users[userId] = { notes: [], summarized: false };
    return state.users[userId];
  }

  return {
    getUserNotes(userId) {
      return state.users[userId]?.notes || [];
    },

    // 生のやり取りの断片を追記する。要約済み(summarized)の状態で追記されると
    // 生ログと要約が混ざってしまうので、その場合は一旦リセットしてから積み直す
    addUserNote(userId, note) {
      const user = ensureUser(userId);
      if (user.summarized) {
        user.notes = [];
        user.summarized = false;
      }
      user.notes.push(note);
      if (user.notes.length > MAX_RAW_NOTES) user.notes.shift();
      save();
    },

    // 生ログが十分溜まっているか(要約すべきタイミングか)
    shouldCompress(userId) {
      const user = state.users[userId];
      return Boolean(user && !user.summarized && user.notes.length >= MAX_RAW_NOTES);
    },

    // 要約結果で置き換える
    setSummarizedNotes(userId, notes) {
      const user = ensureUser(userId);
      user.notes = notes.slice(-MAX_SUMMARY_NOTES);
      user.summarized = true;
      save();
    },

    getTopics() {
      return state.topics;
    },

    addTopic(topic) {
      if (!topic || state.topics.includes(topic)) return;
      state.topics.push(topic);
      if (state.topics.length > MAX_TOPICS) state.topics.shift();
      save();
    },

    // 直近の自分の発言(bot臭さ対策の「同じ言い回し・絵文字を繰り返さない」チェック用)。
    // 以前はaccountState上のメモリだけに保持しており、pm2再起動のたびに空になって
    // いた。他の長期記憶(users/topics)と同じくファイルに永続化することで、
    // 再起動を挟んでも直近の言い回しを覚えたままにする
    getRecentReplies() {
      return state.recentReplies;
    },

    addRecentReply(text) {
      if (!text) return;
      state.recentReplies.push(text);
      if (state.recentReplies.length > MAX_RECENT_REPLIES) state.recentReplies.shift();
      save();
    }
  };
}

module.exports = { createMemoryStore };
