// 5ch自動まとめスクリプト。スレを取得し、まとめブログ風のHTMLファイルに書き出す。
// ボット本体とは独立した単体スクリプトで、Discordには何も投稿しない。
//
// 使い方:
//   node scripts/matome.js <スレURL>                 指定スレをまとめる
//   node scripts/matome.js --latest                  実況Gの最新ID非表示🏡スレをまとめる
//   node scripts/matome.js --file <保存したdat>        手元のdat(Shift_JIS)からまとめる
// オプション:
//   --min-replies N   この数以上の安価が付いたレスを拾う(既定3)
//   --max N           拾う「人気レス」の上限(既定30)
//   --replies N       人気レスごとに添える返信レスの上限(既定3)
//   --total N         まとめ全体のレス数の目安(既定60。人気の高い順に取り、超えたら打ち切る)
//   --no-images       画像URLを画像として埋め込まない(既定は埋め込む)
//   --out <パス>       出力先(既定 outputs/matome-<スレ番号>.html。outputs/はgit管理外)
//
// 選び方はAIを使わず安価の数だけで決める: >>1 → 安価がmin-replies以上付いたレス(+それへの返信)。
// 範囲安価(>>3-9)と4つ以上への一括安価は数えない(コピペ連投が人気扱いになるため)。IDがあれば同じIDは1人。
// 人気レスが安価で始まる時は安価先を前に添え、返信は「草」「w」だけのものを避けて選ぶ。
// 安価の数で文字色・大きさを変える(5以上は赤、3以上は青)、まとめブログの定番の見た目

const fs = require('fs');
const path = require('path');
const config = require('../src/utils/config');
const { fetchSubjects, fetchThread, parseDat, threadUrl, sjis } = require('../src/utils/fivechApi');
const { isThreadIdHidden } = require('../src/handlers/houseWatchHandler');

function parseArgs(argv) {
  const opts = { minReplies: 3, max: 30, replies: 3, total: 60, images: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--latest') opts.latest = true;
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '--min-replies') opts.minReplies = Number(argv[++i]);
    else if (a === '--max') opts.max = Number(argv[++i]);
    else if (a === '--replies') opts.replies = Number(argv[++i]);
    else if (a === '--total') opts.total = Number(argv[++i]);
    else if (a === '--no-images') opts.images = false;
    else if (a === '--out') opts.out = argv[++i];
    else if (/^https?:\/\//.test(a)) opts.url = a;
  }
  return opts;
}

// https://nova.5ch.io/test/read.cgi/livegalileo/1760500000/ → { boardUrl, key }
function parseThreadUrl(url) {
  const m = url.match(/^(https?:\/\/[^/]+)\/test\/read\.cgi\/([^/]+)\/(\d+)/);
  if (!m) throw new Error(`スレURLの形式が違う: ${url}`);
  return { boardUrl: `${m[1]}/${m[2]}/`, key: m[3] };
}

// 実況Gのsubject.txtから🏡入りスレを新しい順に見て、最初に見つかったID非表示スレを返す
async function findLatestHouseThread() {
  const { boardUrl, keyword = '' } = config.houseWatch || {};
  const threads = (await fetchSubjects(boardUrl))
    .filter((t) => (!keyword || t.title.includes(keyword)) && t.resCount >= 2)
    .sort((a, b) => Number(b.key) - Number(a.key));
  for (const t of threads) {
    const thread = await fetchThread(boardUrl, t.key).catch(() => null);
    if (thread && isThreadIdHidden(thread.posts) === true) return { boardUrl, key: t.key, thread };
  }
  throw new Error(`${boardUrl} に${keyword ? `${keyword}入りの` : ''}ID非表示スレが見つからない`);
}

// 本文中の安価(>>12, >>3-5, 全角＞＞も)を拾う。範囲安価は10レス分までに制限
function extractAnchors(body) {
  return parseAnchors(body).targets;
}

// 安価を拾い、人気の数え方に使ってよいか(countable)も返す。
// 範囲安価(>>203-209)やまとめて4つ以上に付けた安価は、コピペ連投への「ここまで〜」や
// 一括の反応なので、1つの返信で全部の人気が上がらないよう数えない
function parseAnchors(body) {
  const targets = new Set();
  let hasRange = false;
  for (const m of body.matchAll(/(?:>>|＞＞)(\d{1,4})(?:[-－](\d{1,4}))?/g)) {
    const from = Number(m[1]);
    const to = m[2] ? Math.min(Number(m[2]), from + 9) : from;
    if (to > from) hasRange = true;
    for (let n = from; n <= to; n++) targets.add(n);
  }
  return { targets: [...targets], countable: !hasRange && targets.size <= 3 };
}

// レス番号 → そのレスに安価を付けたレス番号の配列(自分自身への安価は除外)と、
// 人気の数(数えてよい安価だけ。IDがあれば同じIDの連投は1人として数える)
function buildReplyMap(posts) {
  const map = new Map();
  const voters = new Map();
  for (const p of posts) {
    const { targets, countable } = parseAnchors(p.body);
    for (const target of targets) {
      if (target === p.no) continue;
      if (!map.has(target)) map.set(target, []);
      map.get(target).push(p.no);
      if (!countable) continue;
      if (!voters.has(target)) voters.set(target, new Set());
      voters.get(target).add(p.id || `#${p.no}`);
    }
  }
  const count = (no) => (voters.get(no) ? voters.get(no).size : 0);
  return Object.assign(map, { count });
}

// 「草」「w」「これ」だけのような中身の薄い返信。安価と空白、記号を除いて判定する
function isFiller(body) {
  const rest = body
    .replace(/(?:>>|＞＞)\d{1,4}(?:[-－]\d{1,4})?/g, '')
    .replace(/[\s!！?？。、・…ー〜～w ｗW笑草]/g, '');
  return rest.length <= 2;
}

// 返信の候補から、まとめに載せる分を選ぶ。返信が付いたもの → 中身のあるもの → 早いもの、の順で
// opts.replies件まで取り、時系列に戻す。中身のある返信が無い時だけ薄い返信を1件残す
function pickReplies(candidates, opts, count) {
  const solid = candidates.filter((p) => !isFiller(p.body));
  const pool = solid.length > 0 ? solid : candidates.slice(0, 1);
  return pool
    .map((p, i) => ({ p, i }))
    .sort((a, b) => count(b.p.no) - count(a.p.no) || a.i - b.i)
    .slice(0, opts.replies)
    .map(({ p }) => p)
    .sort((a, b) => a.no - b.no);
}

// 出力するブロック(安価先の文脈・人気レス・その返信)を組み立てる。同じレスは2度出さない。
// 人気の高いものから取り、全体でopts.totalレスを超えたら打ち切って、最後に時系列へ並べ直す
function selectBlocks(posts, opts) {
  const o = { minReplies: 3, max: 30, replies: 3, total: 60, ...opts };
  const byNo = new Map(posts.map((p) => [p.no, p]));
  const replyMap = buildReplyMap(posts);
  const { count } = replyMap;
  const shown = new Set();
  const blocks = [];
  let total = 0;

  const first = byNo.get(1);
  if (first) {
    shown.add(1);
    blocks.push({ context: null, post: first, replies: [] });
    total += 1;
  }

  const popular = posts
    .filter((p) => p.no !== 1 && count(p.no) >= o.minReplies)
    .sort((a, b) => count(b.no) - count(a.no) || a.no - b.no)
    .slice(0, o.max);

  for (const p of popular) {
    if (total >= o.total) break;
    if (shown.has(p.no)) continue;

    // 「>>36 お前の負けーwww」のように安価先が無いと意味が取れないレスには、安価先を前に添える
    const { targets, countable } = parseAnchors(p.body);
    const parentNo = countable ? targets.find((n) => n < p.no && byNo.has(n) && !shown.has(n)) : undefined;
    const context = parentNo ? byNo.get(parentNo) : null;

    const candidates = (replyMap.get(p.no) || [])
      .filter((no) => !shown.has(no) && byNo.has(no))
      .map((no) => byNo.get(no))
      .filter((r) => parseAnchors(r.body).countable);
    const replies = pickReplies(candidates, o, count);

    for (const r of [context, p, ...replies]) if (r) shown.add(r.no);
    blocks.push({ context, post: p, replies });
    total += 1 + (context ? 1 : 0) + replies.length;
  }

  blocks.sort((a, b) => (a.context || a.post).no - (b.context || b.post).no);
  return { blocks, count };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const IMAGE_URL = /\.(?:jpe?g|png|gif|webp)(?:\?\S*)?$/i;

// 5chでは直リンク避けに先頭のhを抜いた「ttp://」「tps://」がよく使われるので補ってからリンクにする
function normalizeUrl(u) {
  return u.replace(/^h?ttps?:\/\//i, (m) => (/s:/i.test(m) ? 'https://' : 'http://'));
}

// 本文をHTMLにする: エスケープ → URLをリンク化(画像URLは本文の下に画像も出す) → 安価をページ内リンク化 → 改行
function renderBody(body, { images = true } = {}) {
  if (!body.trim()) return '<span class="empty">(本文なし)</span>';
  const imgs = [];
  const html = escapeHtml(body)
    .replace(/(?<![a-z])h?ttps?:\/\/[^\s<]+/gi, (raw) => {
      const url = normalizeUrl(raw);
      if (images && IMAGE_URL.test(url)) imgs.push(url);
      return `<a href="${url}" rel="noopener noreferrer" target="_blank">${raw}</a>`;
    })
    .replace(/(&gt;&gt;|＞＞)(\d{1,4})/g, '<a class="anchor" href="#r$2">$1$2</a>')
    .replace(/\n/g, '<br>');
  const gallery = imgs.map((u) => `<a href="${u}" target="_blank" rel="noopener noreferrer"><img src="${u}" loading="lazy" referrerpolicy="no-referrer" alt=""></a>`);
  return gallery.length ? `${html}<div class="imgs">${gallery.join('')}</div>` : html;
}

function renderPost(post, replyCount, kind, opts) {
  const cls = ['res', kind,  replyCount >= 5 ? 'hot' : replyCount >= 3 ? 'warm' : ''].filter(Boolean).join(' ');
  const badge = replyCount > 0 ? `<span class="badge">返信${replyCount}</span>` : '';
  return `<div class="${cls}" id="r${post.no}">
  <div class="head"><span class="no">${post.no}</span>: <span class="name">${escapeHtml(post.name)}</span> <span class="date">${escapeHtml(post.date)} ${escapeHtml(post.id)}</span>${badge}</div>
  <div class="body">${renderBody(post.body, opts)}</div>
</div>`;
}

function renderHtml({ title, url, posts }, blocks, count, opts = {}) {
  const generated = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const items = blocks
    .map(({ context, post, replies }) =>
      [
        context && renderPost(context, count(context.no), 'parent', opts),
        renderPost(post, count(post.no), '', opts),
        ...replies.map((r) => renderPost(r, count(r.no), 'reply', opts))
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n<hr class="sep">\n');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || 'まとめ')}</title>
<style>
  :root { --bg:#fff; --fg:#222; --muted:#888; --line:#e5e5e5; --hot:#d40000; --warm:#0050c8; --name:#2a8a2a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --fg:#e6e6e6; --muted:#999; --line:#333; --hot:#ff5c5c; --warm:#6aa6ff; --name:#6cc46c; } }
  body { background:var(--bg); color:var(--fg); font-family:system-ui,"Hiragino Sans","Noto Sans JP",sans-serif; max-width:760px; margin:0 auto; padding:16px; line-height:1.7; }
  h1 { font-size:1.35rem; line-height:1.4; border-bottom:3px solid var(--fg); padding-bottom:.4em; }
  .meta { color:var(--muted); font-size:.85rem; margin-bottom:1.5em; word-break:break-all; }
  .res { margin:1.1em 0; }
  .res.reply { margin-left:1.5em; padding-left:.8em; border-left:3px solid var(--line); }
  .res.parent { opacity:.75; font-size:.92em; }
  .empty { color:var(--muted); }
  .imgs img { display:block; max-width:100%; max-height:420px; margin-top:.4em; border-radius:4px; }
  .head { color:var(--muted); font-size:.85rem; }
  .name { color:var(--name); font-weight:bold; }
  .badge { margin-left:.6em; font-size:.75rem; border:1px solid var(--muted); border-radius:4px; padding:0 .4em; }
  .body { margin-top:.2em; word-break:break-word; }
  .warm .body { color:var(--warm); font-weight:bold; }
  .hot .body { color:var(--hot); font-weight:bold; font-size:1.2em; }
  .sep { border:none; border-top:1px dashed var(--line); margin:1.6em 0; }
  a { color:var(--warm); }
  a.anchor { text-decoration:none; }
</style>
</head>
<body>
<h1>${escapeHtml(title || 'まとめ')}</h1>
<div class="meta">元スレ: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a><br>全${posts.length}レス / 生成 ${escapeHtml(generated)}</div>
${items}
</body>
</html>
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let thread;
  let url;

  if (opts.file) {
    thread = parseDat(sjis.decode(fs.readFileSync(opts.file)));
    url = opts.url || path.basename(opts.file);
    opts.key = path.basename(opts.file).replace(/\.dat$/, '');
  } else {
    const target = opts.url ? parseThreadUrl(opts.url) : opts.latest ? await findLatestHouseThread() : null;
    if (!target) {
      console.error('使い方: node scripts/matome.js <スレURL> | --latest | --file <dat>  (詳細はファイル冒頭のコメント)');
      process.exit(1);
    }
    thread = target.thread || (await fetchThread(target.boardUrl, target.key));
    url = threadUrl(target.boardUrl, target.key);
    opts.key = target.key;
  }

  if (thread.posts.length === 0) throw new Error('レスを1件も読み取れなかった');

  const { blocks, count } = selectBlocks(thread.posts, opts);
  const html = renderHtml({ title: thread.title, url, posts: thread.posts }, blocks, count, { images: opts.images });
  const out = opts.out || path.join(__dirname, '..', 'outputs', `matome-${opts.key}.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);

  const picked = blocks.reduce((n, b) => n + (b.context ? 2 : 1) + b.replies.length, 0);
  console.log(`✅ ${thread.title || '(タイトル不明)'}: 全${thread.posts.length}レス中${picked}レスを抜粋 → ${out}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}

module.exports = { extractAnchors, parseAnchors, buildReplyMap, isFiller, selectBlocks, renderBody, renderHtml };
