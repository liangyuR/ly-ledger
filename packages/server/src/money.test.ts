import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { centsToYuan, divRound, e4ToYuan, milliToQty, qtyToMilli, yuanToCents, yuanToE4 } from './money';

describe('元 ↔ 分', () => {
  it('常见写法都能解析', () => {
    assert.equal(yuanToCents('55'), 5500);
    assert.equal(yuanToCents('55.5'), 5550);
    assert.equal(yuanToCents('55.55'), 5555);
    assert.equal(yuanToCents('0.01'), 1);
    assert.equal(yuanToCents('-30'), -3000);
  });

  it('不经过浮点，所以没有 0.1+0.2 那类问题', () => {
    // Number('1.15') * 100 === 114.99999999999999
    assert.equal(yuanToCents('1.15'), 115);
    assert.equal(yuanToCents('8.35'), 835);
    assert.equal(yuanToCents('1234567.89'), 123456789);
  });

  it('超出精度直接报错，不静默截断', () => {
    assert.throws(() => yuanToCents('55.555'), /小数位超出精度/);
  });

  it('非法输入直接报错', () => {
    assert.throws(() => yuanToCents('abc'));
    assert.throws(() => yuanToCents(''));
    assert.throws(() => yuanToCents('1,000'));
  });

  it('格式化保留两位', () => {
    assert.equal(centsToYuan(5500), '55.00');
    assert.equal(centsToYuan(1), '0.01');
    assert.equal(centsToYuan(0), '0.00');
    assert.equal(centsToYuan(-3000), '-30.00');
  });
});

describe('元 ↔ 万分之一元', () => {
  it('四位小数', () => {
    assert.equal(yuanToE4('55'), 550000);
    assert.equal(yuanToE4('55.5'), 555000);
    assert.equal(yuanToE4('55.5555'), 555555);
    assert.equal(e4ToYuan(555000), '55.5000');
  });

  it('五位小数报错', () => {
    assert.throws(() => yuanToE4('55.55555'), /小数位超出精度/);
  });
});

describe('数量 ↔ 千分之一', () => {
  it('整数数量与小数数量', () => {
    assert.equal(qtyToMilli('10'), 10000);
    assert.equal(qtyToMilli('0.5'), 500);
    assert.equal(milliToQty(10000), '10');
    assert.equal(milliToQty(10500), '10.5');
  });
});

describe('四舍五入整数除法', () => {
  it('常规进位与舍去', () => {
    assert.equal(divRound(10n, 3n), 3);
    assert.equal(divRound(11n, 3n), 4);
    assert.equal(divRound(5n, 2n), 3, '.5 进位');
    assert.equal(divRound(4n, 2n), 2);
  });

  it('负数零远离', () => {
    assert.equal(divRound(-5n, 2n), -3);
    assert.equal(divRound(5n, -2n), -3);
    assert.equal(divRound(-4n, -2n), 2);
  });

  it('超过 MAX_SAFE_INTEGER 的中间量', () => {
    // 10^17 / 10^3 = 10^14，结果安全但中间量不安全
    assert.equal(divRound(100000000000000000n, 1000n), 100000000000000);
  });

  it('结果超出安全范围时报错而不是静默失真', () => {
    assert.throws(() => divRound(10n ** 20n, 1n), /超出安全整数范围/);
  });

  it('除零报错', () => {
    assert.throws(() => divRound(1n, 0n), /除数为零/);
  });
});
