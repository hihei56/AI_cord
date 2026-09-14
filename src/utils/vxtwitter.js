// ツイートのステータスURL部分(/ユーザー名/status/ID)だけ抜き出し、埋め込みプレビューが
// 展開されるvxtwitter.comのURLに組み直す。nitterインスタンスのURL・素のtwitter.com/x.com
// のURLのどちらでもパス構造は同じなので、ホストを問わずステータスパスの有無だけで判定する
const STATUS_PATH_RE = /\/[^/]+\/status\/\d+/;

function toVxTwitterUrl(link) {
  if (!link) return null;
  try {
    const url = new URL(link);
    const match = url.pathname.match(STATUS_PATH_RE);
    if (!match) return null;
    return `https://vxtwitter.com${match[0]}`;
  } catch {
    return null;
  }
}

module.exports = { toVxTwitterUrl };
