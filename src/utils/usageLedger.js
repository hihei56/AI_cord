const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');
const logger = require('./logger');
const { todayJST } = require('./datetime');
const aiProvider = require('./aiProvider');

// LLMのトークン消費の台帳と、レート制限(429)を受けたプロバイダの一時停止。
//
// 無料枠(Groqは1日20万トークン)は人間への返信・自律エージェント・AI同士の掛け合いで
// 共有している。バックグラウンドの処理(エージェント・掛け合い)は人間がいなくても
// 延々回るため、放っておくと枠を食い潰し、人間に話しかけられた時に429で返信できない
// という一番まずい状態になる。そこで:
// 1) runBackground()の中で行われたLLM呼び出しを「バックグラウンド消費」として数え、
//    1日の上限(budget.backgroundDailyTokens)を超えたらバックグラウンド側だけ止める
// 2) 429を返したプロバイダはretry-afterの間(無ければ既定値)呼ばずに飛ばす。
//    毎回叩いて429を受け続けるのはトークンは食わないが無駄なリクエストと遅延になる
const als = new AsyncLocalStorage();
const filePath = path.join(__dirname, '..', '..', 'data', 'token-usage.json');

const BACKGROUND_DAILY_TOKENS = config.budget?.backgroundDailyTokens ?? 80000;
const DEFAULT_COOLDOWN_MS = config.budget?.rateLimitCooldownMs ?? 60000;

let state;
try {
  state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
} catch {
  state = {};
}

function today() {
  const date = todayJST();
  if (state.date !== date) state = { date, human: 0, background: 0, byProvider: {}, backgroundByProvider: {} };
  state.backgroundByProvider = state.backgroundByProvider || {};
  return state;
}

let writeTimer = null;
function saveSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, JSON.stringify(state, null, 2));
    } catch (err) {
      logger.error('USAGE', err);
    }
  }, 5000);
}

function runBackground(fn) {
  return als.run({ background: true }, fn);
}

function isBackground() {
  return Boolean(als.getStore()?.background);
}

function record(provider, tokens) {
  if (!tokens) return;
  const s = today();
  if (isBackground()) {
    s.background += tokens;
    s.backgroundByProvider[provider || 'custom'] = (s.backgroundByProvider[provider || 'custom'] || 0) + tokens;
  } else {
    s.human += tokens;
  }
  s.byProvider[provider || 'custom'] = (s.byProvider[provider || 'custom'] || 0) + tokens;
  saveSoon();
}

// 上限の目的は「人間への返信用プロバイダの枠を残すこと」なので、数えるのはバックグラウンドが
// 人間用プロバイダで消費した分だけ。Logfare等の別プロバイダに逃がせている間は上限に数えず、
// 逃がし先が落ちてフォールバックで人間用プロバイダに流れ込んだ分だけが上限に効く
function backgroundBudgetLeft() {
  return BACKGROUND_DAILY_TOKENS - (today().backgroundByProvider[aiProvider.getProvider()] || 0);
}

// バックグラウンド処理を新しく始めてよいか(呼び出し側で開始前に確認する)
function canStartBackground() {
  return backgroundBudgetLeft() > 0;
}

const cooldownUntil = new Map();

function coolDown(provider, retryAfterHeader) {
  const sec = Number(retryAfterHeader);
  const ms = Number.isFinite(sec) && sec > 0 ? sec * 1000 : DEFAULT_COOLDOWN_MS;
  cooldownUntil.set(provider || 'custom', Date.now() + ms);
  logger.log('USAGE', `${provider || 'custom'}がレート制限(429)を返したため${Math.round(ms / 1000)}秒間スキップ`);
}

function isCoolingDown(provider) {
  return (cooldownUntil.get(provider || 'custom') || 0) > Date.now();
}

function summary() {
  const s = today();
  return { ...s, backgroundBudget: BACKGROUND_DAILY_TOKENS };
}

module.exports = { runBackground, isBackground, record, canStartBackground, backgroundBudgetLeft, coolDown, isCoolingDown, summary };
