const fs = require('fs');
const path = require('path');
const config = require('./config');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'price-alerts.json');

// 通知先チャンネル・監視銘柄・前回アラート時の基準価格・銘柄の手動解決指定を
// data/price-alerts.json に永続化する(.envを書き換えずコマンドだけで設定できるように)。
function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return { channelId: null, symbols: [...(config.priceAlert?.defaultSymbols || [])], refPrices: {}, overrides: {} };
  }
}

const state = load();
state.symbols = state.symbols || [];
state.refPrices = state.refPrices || {};
state.overrides = state.overrides || {};

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

function getChannelId() {
  return state.channelId;
}

function setChannelId(channelId) {
  state.channelId = channelId;
  save();
}

function getSymbols() {
  return state.symbols;
}

function addSymbol(symbol) {
  const s = symbol.toLowerCase();
  if (state.symbols.includes(s)) return false;
  state.symbols.push(s);
  save();
  return true;
}

function removeSymbol(symbol) {
  const s = symbol.toLowerCase();
  const idx = state.symbols.indexOf(s);
  if (idx === -1) return false;
  state.symbols.splice(idx, 1);
  delete state.refPrices[s];
  delete state.overrides[s];
  save();
  return true;
}

function getRefPrice(symbol) {
  return state.refPrices[symbol.toLowerCase()];
}

function setRefPrice(symbol, price) {
  state.refPrices[symbol.toLowerCase()] = price;
  save();
}

function getOverrides() {
  return state.overrides;
}

function setOverride(symbol, value) {
  state.overrides[symbol.toLowerCase()] = value;
  save();
}

module.exports = {
  getChannelId,
  setChannelId,
  getSymbols,
  addSymbol,
  removeSymbol,
  getRefPrice,
  setRefPrice,
  getOverrides,
  setOverride
};
