const logger = require('./logger');

// 5chの専ブラ慣習に合わせてMonazilla形式のUAを名乗る(5ch.io対応の専ブラEmberも
// subject.txt/datの取得にMonazilla/1.00 Ember/0.1を使っている)。ブラウザのUAを偽装するより
// 素性が明確で、運営側の専ブラ向け経路として扱われる
const USER_AGENT = 'Monazilla/1.00 AI_cord/2.0';
// 5chのsubject.txt/read.cgiはShift_JIS。絵文字はShift_JISに無いので&#127969;のような
// 数値文字参照で格納されている。Node標準のTextDecoder(full-icu)でデコードする
const sjis = new TextDecoder('shift_jis');

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// 5ch側が応答を返さないまま接続を保持すると、fetchは既定でタイムアウトせず永久に待つ。
// そうなるとお🏡検知の定期チェック(前回が終わってから次を予約する)ごと止まるので必ず打ち切る
const FETCH_TIMEOUT_MS = 20000;

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return sjis.decode(await res.arrayBuffer());
}

// boardUrl例: https://nova.5ch.io/livegalileo/
// subject.txtの1行は「1234567890.dat<>スレタイ (レス数)」
async function fetchSubjects(boardUrl) {
  const text = await fetchText(new URL('subject.txt', boardUrl).href);
  const threads = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d+)\.dat<>(.*)\s\((\d+)\)\s*$/);
    if (!m) continue;
    threads.push({ key: m[1], title: decodeEntities(m[2]), resCount: Number(m[3]) });
  }
  return threads;
}

function threadUrl(boardUrl, key) {
  const u = new URL(boardUrl);
  const board = u.pathname.split('/').filter(Boolean)[0];
  return `${u.origin}/test/read.cgi/${board}/${key}/`;
}

// >>1の本文を取得する。!extend:付きで立てたスレは>>1末尾に
// 「VIPQ2_EXTDAT: none:none:1000:512:: EXT was configured」が自動で付くので、それで判定できる。
// Emberと同じくまず軽いdat(1行目が>>1)を取り、取れなければread.cgiのHTMLにフォールバックする
async function fetchFirstPost(boardUrl, key) {
  const u = new URL(boardUrl);
  const board = u.pathname.split('/').filter(Boolean)[0];
  try {
    const dat = await fetchText(`${u.origin}/${board}/dat/${key}.dat`);
    const first = dat.split('\n')[0];
    if (first.includes('<>')) return first;
  } catch {
    // dat不可(過去ログ化・アクセス制限等)ならread.cgiへ
  }
  try {
    const html = await fetchText(`${threadUrl(boardUrl, key)}1`);
    // レス本体が無いHTML(エラーページ・規制ページ等)を「IDが無い」と誤判定しないよう判定保留にする。
    // 現行のread.cgiは<article id="1">…<section class="post-content">形式、旧形式はdiv.post/<dd>
    // (onihusube/2chAPIProxyのHTML→dat変換の正規表現と同じ判定材料)
    if (!/class="post-content"|<article id=|class="(clear )?post"|<dd/.test(html)) {
      logger.log('HOUSE', `${key}: read.cgiにレス本体が無いため判定保留`);
      return null;
    }
    return html;
  } catch (err) {
    logger.error('HOUSE', err);
    return null;
  }
}

// レス本文/名前のHTMLをプレーンテキストにする(<br>は改行、アンカーの<a>等のタグは除去、実体参照は戻す)
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

// 本文末尾に自動で付くEXTDAT行(<hr>VIPQ2_EXTDAT: ...)を表示用に取り除く
function stripExtdat(html) {
  return html.replace(/<hr>\s*VIPQ2_EXTDAT:[\s\S]*$/i, '');
}

// dat(1行1レス「名前<>メール<>日付 ID<>本文<>スレタイ」)をレス配列にする
function parseDat(text) {
  const posts = [];
  let title = null;
  text.split('\n').forEach((line, i) => {
    const f = line.split('<>');
    if (f.length < 4) return;
    if (i === 0 && f[4]) title = htmlToText(f[4]);
    const idMatch = f[2].match(/\s(ID:\S+)/);
    posts.push({
      no: i + 1,
      name: htmlToText(f[0]),
      mail: htmlToText(f[1]),
      date: htmlToText(f[2].replace(/\s?ID:\S+/, '')).trim(),
      id: idMatch ? idMatch[1] : '',
      body: htmlToText(stripExtdat(f[3]))
    });
  });
  return { title, posts };
}

// 現行read.cgi(<article id="N">…<span class="date">…<span class="uid">…<section class="post-content">)を
// レス配列にする。形式はonihusube/2chAPIProxyのHTML→dat変換の正規表現に合わせている
function parseReadCgi(html) {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const posts = [];
  for (const block of html.split(/<article\s+id="/).slice(1)) {
    const no = Number(block.match(/^(\d+)/)?.[1]);
    const pick = (re) => block.match(re)?.[1] ?? '';
    if (!no) continue;
    posts.push({
      no,
      name: htmlToText(pick(/class="postusername">([\s\S]*?)<\/span>/)),
      mail: '',
      date: htmlToText(pick(/class="date">([\s\S]*?)<\/span>/)),
      id: htmlToText(pick(/class="uid">([\s\S]*?)<\/span>/)),
      body: htmlToText(stripExtdat(pick(/class="post-content">([\s\S]*?)<\/section>/)))
    });
  }
  return { title: titleMatch ? htmlToText(titleMatch[1]) : null, posts };
}

// スレ全体を取得する。dat優先、取れなければread.cgiのHTML
async function fetchThread(boardUrl, key) {
  const u = new URL(boardUrl);
  const board = u.pathname.split('/').filter(Boolean)[0];
  try {
    const parsed = parseDat(await fetchText(`${u.origin}/${board}/dat/${key}.dat`));
    if (parsed.posts.length > 0) return parsed;
  } catch {
    // read.cgiへ
  }
  return parseReadCgi(await fetchText(threadUrl(boardUrl, key)));
}

module.exports = {
  fetchSubjects,
  fetchFirstPost,
  fetchThread,
  threadUrl,
  decodeEntities,
  parseDat,
  parseReadCgi,
  sjis
};
