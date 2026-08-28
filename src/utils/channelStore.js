const fs = require('fs');
const path = require('path');
const config = require('./config');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'channels.json');

function load() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    return new Set(JSON.parse(raw));
  } catch {
    return new Set([config.env.allowedChannelId].filter(Boolean));
  }
}

const channels = load();

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify([...channels], null, 2));
}

function isAllowedChannel(channelId) {
  return channels.has(channelId);
}

function addChannel(channelId) {
  const added = !channels.has(channelId);
  channels.add(channelId);
  if (added) save();
  return added;
}

function removeChannel(channelId) {
  const removed = channels.delete(channelId);
  if (removed) save();
  return removed;
}

function listChannels() {
  return [...channels];
}

module.exports = { isAllowedChannel, addChannel, removeChannel, listChannels };
