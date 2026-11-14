const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { readJson } = require('./jsonFile');
const { isHuman } = require('./humanPresence');

// 他サーバーの会話の観察: 監視対象に登録したチャンネルの人間の発言を、本文だけの
// プレーンテキストで溜めておく。AIはこれを「実際の人間の口調・長さ・ノリの手本」として
// 参照する(aiClient)。安いモデルは口調を説明文で指示するより実例を見せる方がずっと
// 自然に真似るため。
//
// - 既に受信しているmessageCreateを記録するだけで、履歴の追加fetchはしない
// - 発言者の名前・IDは保存しない。メンション・URL・カスタム絵文字は取り除く
// - 溜めた発言をそのまま投稿させない(手本としてのみ使い、ほぼ同じ文が生成されたら捨てる)
// 保存先: data/observed.json(監視チャンネル一覧と直近MAX_LINES件の本文)
const OBS = { maxLines: 2000, minLength: 2, maxLength: 80, examples: 6, ...(config.observe || {}) };
const FILE = path.join(__dirname, '..', '..', 'data', 'observed.json');
const SAVE_DEBOUNCE_MS = 30000;
const SEEN_MAX = 2000;

const state = readJson(FILE, {});
state.channels = state.channels || (process.env.WATCH_CHANNEL_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
state.lines = state.lines || [];
const watched = new Set(state.channels);

let saveTimer = null;
function saveSoon(delayMs = SAVE_DEBOUNCE_MS) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    state.channels = [...watched];
    fs.promises
      .mkdir(path.dirname(FILE), { recursive: true })
      .then(() => fs.promises.writeFile(FILE, JSON.stringify(state)))
      .catch((err) => logger.error('OBSERVE', err));
  }, delayMs);
  saveTimer.unref?.();
}

// 本文だけのプレーンテキストにする。手本にならないもの(空・長文・コマンド・一斉メンション)はnull
function toPlainText(content) {
  if (!content || /@everyone|@here/.test(content)) return null;
  const text = content
    .replace(/<@[!&]?\d+>|<#\d+>|<a?:\w+:\d+>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < OBS.minLength || text.length > OBS.maxLength) return null;
  if (/^[!/.$?]\w|^\w{1,5}[!?]\w/.test(text)) return null; // 他botへのコマンドらしきもの
  return text;
}

// 同じメッセージを複数アカウントが受信するのでIDで重複を除く
const seen = new Set();

function record(msg) {
  if (!watched.has(msg.channel?.id) || seen.has(msg.id) || !isHuman(msg)) return;
  seen.add(msg.id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  const text = toPlainText(msg.content);
  if (!text || state.lines.at(-1) === text) return;
  state.lines.push(text);
  if (state.lines.length > OBS.maxLines) state.lines.splice(0, state.lines.length - OBS.maxLines);
  saveSoon();
}

function grams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

// 手本にする発言を選ぶ。今の話題に近いもの(文字2-gramの一致が多いもの)を半分まで、
// 残りは直近の発言からランダムに取る(話題が合うものだけだと内容を引きずりやすいため)
function examplesFor(query, count = OBS.examples) {
  return pickExamples(state.lines, query, count);
}

const RECENT_POOL = 300;

function pickExamples(lines, query, count) {
  if (!lines?.length || count <= 0) return [];
  const picked = new Set();
  const q = grams(query || '');
  if (q.size > 0) {
    lines
      .map((line) => ({ line, score: [...grams(line)].filter((g) => q.has(g)).length }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.ceil(count / 2))
      .forEach((x) => picked.add(x.line));
  }
  const recent = lines.slice(-RECENT_POOL);
  for (let tries = 0; picked.size < Math.min(count, lines.length) && tries < count * 5; tries++) {
    picked.add(recent[Math.floor(Math.random() * recent.length)]);
  }
  return [...picked];
}

function register(clients) {
  for (const client of clients) client.on('messageCreate', record);
}

module.exports = {
  register,
  examplesFor,
  pickExamples,
  addChannel(id) {
    watched.add(id);
    saveSoon(0);
  },
  removeChannel(id) {
    const removed = watched.delete(id);
    saveSoon(0);
    return removed;
  },
  listChannels: () => [...watched],
  lineCount: () => state.lines.length,
  recentLines: (n) => state.lines.slice(-n),
  clearLines() {
    state.lines = [];
    saveSoon(0);
  }
};
