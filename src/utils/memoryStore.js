const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { readJson } = require('./jsonFile');

function storePath(accountId) {
  return path.join(__dirname, '..', '..', 'data', `memory-${accountId}.json`);
}

// アカウントごとの長期記憶(ユーザーごとの記憶、直近の自分の発言)を
// data/memory-<accountId>.json に永続化する。
function createMemoryStore(accountId) {
  const filePath = storePath(accountId);

  function load() {
    return readJson(filePath, { users: {} });
  }

  const state = load();
  state.users = state.users || {};
  state.recentReplies = state.recentReplies || [];

  // 人ごとの記憶は「分かったこと(facts)」と「まだまとめていないやり取り(raw)」の2つで持つ。
  // rawがMAX_RAW_NOTES件溜まったら、既存のfactsと合わせて書き直す(aiClientのcompressUserMemoryIfNeeded)。
  // 以前は要約した後、次のやり取りが1件来た時点で要約を捨てて溜め直していたため、
  // 覚えていられるのは常に直近8回分だけで、記憶が積み上がらなかった
  const MAX_RAW_NOTES = 8;
  const MAX_FACTS = 15;
  const RAW_IN_PROMPT = 3;
  const MAX_RECENT_REPLIES = 4;

  // 返信のたびに(addUserNote/addRecentReply経由で)呼ばれるため、同期的な
  // fs.writeFileSyncだとNode.jsのイベントループをその都度ブロックしてしまい、
  // 複数アカウント運用時は1アカウントの保存中に他アカウントのメッセージ処理も
  // 止まってしまう。非同期writeに切り替えつつ、呼び出し元の関数シグネチャは
  // 変えたくない(いちいちawaitさせたくない)ので、書き込みをキューに繋げて
  // 直列実行することで、非同期化しつつ複数の書き込みが競合して古い状態で
  // 上書きされる(=後から完了した古い書き込みで最新の状態が消える)ことを防ぐ
  // 返信1回ごとにaddUserNoteとaddRecentReplyの2回保存が走り、そのたびに全ユーザー分の
  // 記憶をJSON化して書き込んでいた。2秒以内の保存要求は1回の書き込みにまとめる
  // (書き込み自体は従来通りキューで直列化し、古い状態で上書きされないようにする)
  let writeQueue = Promise.resolve();
  let saveScheduled = false;
  function save() {
    if (saveScheduled) return;
    saveScheduled = true;
    setTimeout(() => {
      saveScheduled = false;
      const snapshot = JSON.stringify(state, null, 2);
      writeQueue = writeQueue
        .then(() => fs.promises.mkdir(path.dirname(filePath), { recursive: true }))
        .then(() => fs.promises.writeFile(filePath, snapshot))
        .catch((err) => logger.error('MEMORY', err));
    }, 2000);
  }

  // 旧形式({ notes, summarized })から移行する。要約済みならそれを分かったこととして引き継ぐ
  for (const [id, u] of Object.entries(state.users)) {
    if (Array.isArray(u.facts)) continue;
    state.users[id] = { facts: u.summarized ? u.notes || [] : [], raw: u.summarized ? [] : u.notes || [], updatedAt: null };
  }

  function ensureUser(userId) {
    if (!state.users[userId]) state.users[userId] = { facts: [], raw: [], updatedAt: null };
    return state.users[userId];
  }

  return {
    // プロンプトに入れる記憶: 分かったことと、まだまとめていない直近のやり取り数件
    getUserNotes(userId) {
      const u = state.users[userId];
      return u ? [...u.facts, ...u.raw.slice(-RAW_IN_PROMPT)] : [];
    },

    getFacts(userId) {
      return state.users[userId]?.facts || [];
    },

    getRaw(userId) {
      return state.users[userId]?.raw || [];
    },

    addUserNote(userId, note) {
      const user = ensureUser(userId);
      user.raw.push(note);
      // まとめに失敗し続けても無限に溜まらないよう、上限の2倍で古いものから捨てる
      if (user.raw.length > MAX_RAW_NOTES * 2) user.raw.shift();
      save();
    },

    shouldCompress(userId) {
      return (state.users[userId]?.raw.length || 0) >= MAX_RAW_NOTES;
    },

    // まとめ直した「分かったこと」で置き換え、まとめに使ったやり取りを消す
    setFacts(userId, facts, consumedRawCount) {
      const user = ensureUser(userId);
      user.facts = facts.slice(0, MAX_FACTS);
      user.raw = user.raw.slice(consumedRawCount);
      user.updatedAt = Date.now();
      save();
    },

    forget(userId) {
      const had = Boolean(state.users[userId]);
      delete state.users[userId];
      save();
      return had;
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
