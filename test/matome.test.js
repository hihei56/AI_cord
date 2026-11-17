require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnchors, buildReplyMap, isFiller, selectBlocks, renderBody } = require('../scripts/matome');

const post = (no, body, id = '') => ({ no, name: '名無し', mail: '', date: '', id, body });

test('まとめ: 範囲安価と4つ以上への一括安価は人気に数えない', () => {
  assert.deepEqual(parseAnchors('>>3-5 ここまで').countable, false);
  assert.deepEqual(parseAnchors('>>3 >>4 >>5 >>6').countable, false);
  assert.deepEqual(parseAnchors('>>3 >>4').countable, true);
  const posts = [post(1, 'スレ立て'), post(2, 'コピペ'), post(3, 'コピペ'), post(4, '>>2-3 ここまでコピペ'), post(5, '>>2 草')];
  const { count } = buildReplyMap(posts);
  assert.equal(count(2), 1);
  assert.equal(count(3), 0);
});

test('まとめ: IDがあれば同じIDの連投は1人として数える', () => {
  const posts = [post(1, ''), post(2, 'ネタ', 'ID:a'), post(3, '>>2 a', 'ID:b'), post(4, '>>2 b', 'ID:b'), post(5, '>>2 c', 'ID:c')];
  assert.equal(buildReplyMap(posts).count(2), 2);
});

test('まとめ: 中身の薄い返信の判定', () => {
  for (const s of ['>>3\n草', 'w', 'ｗｗｗ', '>>3 これ', '…']) assert.equal(isFiller(s), true, s);
  for (const s of ['>>3 会議中なのに笑っちゃった', '勝負服だぞ']) assert.equal(isFiller(s), false, s);
});

test('まとめ: 安価で始まる人気レスには安価先を添え、薄い返信は避ける', () => {
  const posts = [
    post(1, 'スレ立て'),
    post(2, '自演うざいから閉じるね'),
    post(3, '>>2\nお前の負けーwww'),
    post(4, '>>3 草'),
    post(5, '>>3 やりますねえ'),
    post(6, '>>3 ｗ'),
    post(7, '>>3 これは効いてる')
  ];
  const { blocks } = selectBlocks(posts, { minReplies: 3 });
  const b = blocks.find((x) => x.post.no === 3);
  assert.equal(b.context.no, 2);
  assert.deepEqual(b.replies.map((r) => r.no), [5, 7]);
});

test('まとめ: 全体のレス数の上限で打ち切り、時系列に並べる', () => {
  const posts = [post(1, 'スレ立て')];
  for (let i = 0; i < 10; i++) {
    const base = posts.length + 1;
    posts.push(post(base, `ネタ${i}`));
    for (let j = 0; j < 3 + i; j++) posts.push(post(posts.length + 1, `>>${base} 返信${i}-${j}です`));
  }
  const { blocks } = selectBlocks(posts, { total: 10, replies: 3 });
  const nos = blocks.map((b) => b.post.no);
  assert.deepEqual(nos, [...nos].sort((a, b) => a - b));
  assert.ok(blocks.reduce((n, b) => n + 1 + b.replies.length, 0) <= 13);
  assert.ok(nos.includes(posts.find((p) => p.body === 'ネタ9').no), '人気の高いものが残る');
});

test('まとめ: 本文の描画(h抜きURL・画像・空の本文)', () => {
  const html = renderBody('見て ttps://i.imgur.com/a.jpg <b>');
  assert.match(html, /href="https:\/\/i\.imgur\.com\/a\.jpg"/);
  assert.match(html, /<img src="https:\/\/i\.imgur\.com\/a\.jpg"/);
  assert.match(html, /&lt;b&gt;/);
  assert.doesNotMatch(renderBody('ttps://i.imgur.com/a.jpg', { images: false }), /<img/);
  assert.match(renderBody(''), /本文なし/);
});
