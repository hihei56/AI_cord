function log(tag, message) {
  console.log(`[${tag}] ${message}`);
}

function error(tag, err) {
  console.error(`[${tag} ERR]`, err?.message || err);
}

module.exports = { log, error };
