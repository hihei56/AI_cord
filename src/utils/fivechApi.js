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

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
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

module.exports = { fetchSubjects, fetchFirstPost, threadUrl, decodeEntities };
