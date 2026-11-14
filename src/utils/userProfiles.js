const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { readJson } = require('./jsonFile');

// ユーザーごとの人物メモ(運営が書くデータベース)。memoryStoreの記憶はAIが会話から
// 自動でまとめるもの(アカウントごと・要約で上書きされる)だが、こちらは人が書いた内容を
// そのまま保持し、全アカウントで共有する。その人から話しかけられた時にプロンプトへ入れ、
// 相手がどういう人かを踏まえた返事をさせる。
// 保存先: data/user-profiles.json({ ユーザーID: [メモ, ...] })
const FILE = path.join(__dirname, '..', '..', 'data', 'user-profiles.json');
const MAX_NOTES_PER_USER = 10;
const MAX_NOTE_LENGTH = 200;

const profiles = readJson(FILE, {});

function save() {
  fs.promises
    .mkdir(path.dirname(FILE), { recursive: true })
    .then(() => fs.promises.writeFile(FILE, JSON.stringify(profiles, null, 2)))
    .catch((err) => logger.error('PROFILE', err));
}

module.exports = {
  get: (userId) => profiles[userId] || [],
  add(userId, note) {
    const text = (note || '').trim().slice(0, MAX_NOTE_LENGTH);
    if (!text) return false;
    profiles[userId] = [...(profiles[userId] || []), text].slice(-MAX_NOTES_PER_USER);
    save();
    return true;
  },
  clear(userId) {
    const had = Boolean(profiles[userId]?.length);
    delete profiles[userId];
    save();
    return had;
  }
};
