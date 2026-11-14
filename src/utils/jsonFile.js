const fs = require('fs');
const logger = require('./logger');

// data/ 以下のJSONファイルの読み込み。ファイルが無い(初回起動)のは正常なので黙って
// fallbackを返すが、「あるのに読めない・壊れている」場合は黙ってfallbackにすると、
// 次の保存で空の状態が上書きされて蓄積データ(記憶・統計)が気付かないうちに消える。
// 壊れたファイルは別名で退避し、ログに残す
function readJson(filePath, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') logger.error('STORE', `${filePath} を読めません: ${err.message}`);
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const backup = `${filePath}.broken-${Date.now()}`;
    try {
      fs.copyFileSync(filePath, backup);
      logger.error('STORE', `${filePath} が壊れています(${err.message})。${backup} に退避し、空の状態で続行します`);
    } catch (copyErr) {
      logger.error('STORE', `${filePath} が壊れています(${err.message})。退避にも失敗: ${copyErr.message}`);
    }
    return fallback;
  }
}

module.exports = { readJson };
