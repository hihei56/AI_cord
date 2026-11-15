require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixRandom } = require('./helpers');
const { textMentionsName } = require('../src/utils/nicknames');
const { maybeSplit } = require('../src/utils/splitSend');

test('名前で呼ばれたかの判定: 英字の短い名前は単語の一部に一致しない', () => {
  assert.equal(textMentionsName('miはどう思う？', 'mi'), true);
  assert.equal(textMentionsName('mini買った', 'mi'), false);
  assert.equal(textMentionsName('suica忘れた', 'sui'), false);
  assert.equal(textMentionsName('ねえSUI!', 'sui'), true);
  assert.equal(textMentionsName('とくちゃん元気', 'とく'), true);
  assert.equal(textMentionsName('aaa', 'a'), false);
  assert.equal(textMentionsName(null, 'mi'), false);
});

test('分割送信: 文の切れ目でだけ2つに分ける', () => {
  const restore = fixRandom(0);
  try {
    assert.deepEqual(maybeSplit('それはさすがに盛りすぎだろ 前も同じこと言ってたじゃん'), [
      'それはさすがに盛りすぎだろ',
      '前も同じこと言ってたじゃん'
    ]);
    assert.equal(maybeSplit('まあ わかる 気はするけどさすがにそれは無理あるわ').length, 1, '言葉の途中では切らない');
    assert.equal(maybeSplit('それな').length, 1, '短文は分けない');
  } finally {
    restore();
  }
});

test('分割送信: 確率を外れたら分けない', () => {
  const restore = fixRandom(0.99);
  try {
    assert.equal(maybeSplit('それはさすがに盛りすぎだろ 前も同じこと言ってたじゃん').length, 1);
  } finally {
    restore();
  }
});
