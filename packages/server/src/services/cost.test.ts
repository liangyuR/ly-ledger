import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { yuanToE4, qtyToMilli } from '../money';
import { applyPurchase, applySale, reversePurchase, type Stock } from './cost';

const stock = (qty: string, cost: string): Stock => ({
  qtyMilli: qtyToMilli(qty),
  avgCostE4: yuanToE4(cost),
});

describe('移动加权平均成本', () => {
  it('正常进货加权：(10×50 + 10×60) / 20 = 55', () => {
    const r = applyPurchase(stock('10', '50'), qtyToMilli('10'), yuanToE4('60'));
    assert.equal(r.qtyMilli, qtyToMilli('20'));
    assert.equal(r.avgCostE4, yuanToE4('55'));
  });

  it('零库存进货：新均价 = 进价，不是除零', () => {
    const r = applyPurchase(stock('0', '99'), qtyToMilli('10'), yuanToE4('60'));
    assert.equal(r.avgCostE4, yuanToE4('60'));
  });

  it('负库存进货：新均价 = 进价，不套加权公式', () => {
    // 若套公式：(-5×50 + 10×60) / 5 = 70，凭空多出 10 块成本
    const r = applyPurchase(stock('-5', '50'), qtyToMilli('10'), yuanToE4('60'));
    assert.equal(r.qtyMilli, qtyToMilli('5'));
    assert.equal(r.avgCostE4, yuanToE4('60'));
  });

  it('进完仍为负：新均价 = 进价', () => {
    const r = applyPurchase(stock('-20', '50'), qtyToMilli('10'), yuanToE4('60'));
    assert.equal(r.qtyMilli, qtyToMilli('-10'));
    assert.equal(r.avgCostE4, yuanToE4('60'));
  });

  it('整条价 550 拆 10 包 = 55.0000，无精度丢失', () => {
    const perPack = yuanToE4('550') / 10;
    assert.equal(perPack, yuanToE4('55'));
    const r = applyPurchase(stock('0', '0'), qtyToMilli('10'), perPack);
    assert.equal(r.avgCostE4, yuanToE4('55.0000'));
  });

  it('整箱 333 拆 6 瓶 = 55.5000 —— 四位小数的必要性', () => {
    const perBottle = yuanToE4('333') / 6;
    assert.equal(perBottle, yuanToE4('55.5'));
    // 两位小数会变成 55.50 或 55.5，这里精确
    assert.equal(perBottle, 555000);
  });

  it('销售：均价不变，结存可以变负', () => {
    const r = applySale(stock('2', '55'), qtyToMilli('5'));
    assert.equal(r.qtyMilli, qtyToMilli('-3'));
    assert.equal(r.avgCostE4, yuanToE4('55'), '负库存下仍沿用最后已知均价');
  });

  it('加权结果除不尽时四舍五入到 e4', () => {
    // (1×10 + 2×20) / 3 = 16.666666...
    const r = applyPurchase(stock('1', '10'), qtyToMilli('2'), yuanToE4('20'));
    assert.equal(r.avgCostE4, 166667); // 16.6667
  });

  it('中间量超过安全整数范围也不出错（BigInt）', () => {
    // 10 万件 × 单价 9999 元：中间量 ≈ 10^8 × 10^8 = 10^16 > MAX_SAFE_INTEGER
    const big = applyPurchase(
      { qtyMilli: qtyToMilli('100000'), avgCostE4: yuanToE4('9999') },
      qtyToMilli('100000'),
      yuanToE4('9999'),
    );
    assert.equal(big.avgCostE4, yuanToE4('9999'));
  });
});

describe('作废进货的反向调整', () => {
  it('撤回刚进的那批，均价回到原值', () => {
    const after = applyPurchase(stock('10', '50'), qtyToMilli('10'), yuanToE4('60'));
    const back = reversePurchase(after, qtyToMilli('10'), yuanToE4('60'));
    assert.equal(back.qtyMilli, qtyToMilli('10'));
    assert.equal(back.avgCostE4, yuanToE4('50'));
  });

  it('作废后结存归零或转负：保持原均价', () => {
    const r = reversePurchase(stock('10', '55'), qtyToMilli('10'), yuanToE4('55'));
    assert.equal(r.qtyMilli, 0);
    assert.equal(r.avgCostE4, yuanToE4('55'));
  });

  it('反算出负成本时 clamp 到 0 并告警', () => {
    // 均价被后续低价货拉到 5，此时去撤一笔 100 块的高价进货：
    // (100×5 − 10×100) / 90 = −5.55...，真的会算出负成本
    const r = reversePurchase(stock('100', '5'), qtyToMilli('10'), yuanToE4('100'));
    assert.equal(r.avgCostE4, 0, '绝不写入负成本');
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].code, 'negative_avg_clamped');
  });
});

describe('入参防线', () => {
  it('进货数量为零或负数直接拒绝', () => {
    assert.throws(() => applyPurchase(stock('1', '1'), 0, 100));
    assert.throws(() => applyPurchase(stock('1', '1'), -1000, 100));
  });

  it('进价为负直接拒绝', () => {
    assert.throws(() => applyPurchase(stock('1', '1'), 1000, -1));
  });

  it('出库数量为零或负数直接拒绝', () => {
    assert.throws(() => applySale(stock('1', '1'), 0));
  });
});
