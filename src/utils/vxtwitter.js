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

// 本文中に貼られたtwitter.com/x.com/nitter等のツイートリンクだけをvxtwitter.comに
// 置き換える(それ以外のURL・テキストはそのまま)。relayHandler.js(チャンネル転送)で、
// 転送元が貼った生のツイートリンクも埋め込みプレビューが展開される形にするために使う
function convertTweetLinksInText(text) {
  if (!text) return text;
  return text.replace(/https?:\/\/\S+/g, (url) => toVxTwitterUrl(url) || url);
}

module.exports = { toVxTwitterUrl, convertTweetLinksInText };
