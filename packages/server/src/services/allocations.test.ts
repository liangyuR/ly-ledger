import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { yuanToCents } from '../money';
import {
  agingDays,
  computeAllocations,
  type PaymentForAlloc,
  type SaleForAlloc,
} from './allocations';

const sale = (id: number, bizDate: string, yuan: string, returnOf: number | null = null): SaleForAlloc => ({
  id,
  bizDate,
  totalCents: yuanToCents(yuan),
  returnOfSaleId: returnOf,
});

const pay = (id: number, bizDate: string, yuan: string): PaymentForAlloc => ({
  id,
  bizDate,
  amountCents: yuanToCents(yuan),
});

describe('FIFO 核销', () => {
  it('一笔收款按日期顺序填满多张单', () => {
    const r = computeAllocations(
      [sale(1, '2026-08-05', '1000'), sale(2, '2026-08-20', '500')],
      [pay(10, '2026-09-01', '1200')],
    );
    assert.deepEqual(r.allocations, [
      { paymentId: 10, saleId: 1, amountCents: 100000 },
      { paymentId: 10, saleId: 2, amountCents: 20000 },
    ]);
    assert.equal(r.prepaidCents, 0);
    assert.equal(r.outstanding.find((o) => o.saleId === 2)!.outstandingCents, yuanToCents('300'));
  });

  it('收款不足：最后一张部分核销，其余不动', () => {
    const r = computeAllocations(
      [sale(1, '2026-08-05', '1000'), sale(2, '2026-08-20', '500')],
      [pay(10, '2026-09-01', '600')],
    );
    assert.equal(r.allocations.length, 1);
    assert.equal(r.outstanding.find((o) => o.saleId === 1)!.outstandingCents, yuanToCents('400'));
    assert.equal(r.outstanding.find((o) => o.saleId === 2)!.outstandingCents, yuanToCents('500'));
  });

  it('超额收款：余额成为预收，不写核销记录', () => {
    const r = computeAllocations([sale(1, '2026-08-05', '3200')], [pay(10, '2026-09-01', '3500')]);
    assert.equal(r.prepaidCents, yuanToCents('300'));
    assert.equal(r.allocations.reduce((s, a) => s + a.amountCents, 0), yuanToCents('3200'));
  });

  it('多笔收款都用不完：预收是全部剩余之和', () => {
    const r = computeAllocations(
      [sale(1, '2026-08-05', '100')],
      [pay(10, '2026-09-01', '300'), pay(11, '2026-09-02', '200')],
    );
    assert.equal(r.prepaidCents, yuanToCents('400'));
  });

  // 这条和下一条是整套设计的立身之本：
  // 业务日期可改 + FIFO 按日期核销 = 增量追加必然算错账龄
  it('补录一张更早的挂账单：重算后它排在最前，账龄随之改变', () => {
    const payments = [pay(10, '2026-09-10', '600')];

    const before = computeAllocations([sale(2, '2026-09-01', '1000')], payments);
    assert.equal(agingDays(before, '2026-09-19'), 18);

    // 老板补录了一张 8 月 5 日的单
    const after = computeAllocations(
      [sale(2, '2026-09-01', '1000'), sale(3, '2026-08-05', '500')],
      payments,
    );
    // 收款先填最早的那张，剩下 100 填 9-01 那张
    assert.deepEqual(after.allocations, [
      { paymentId: 10, saleId: 3, amountCents: 50000 },
      { paymentId: 10, saleId: 2, amountCents: 10000 },
    ]);
    assert.equal(agingDays(after, '2026-09-19'), 18, '最早未结清的仍是 9-01 那张');
  });

  it('把某单的业务日期改早：核销顺序跟着变', () => {
    const sales = [sale(1, '2026-09-01', '500'), sale(2, '2026-09-05', '500')];
    const payments = [pay(10, '2026-09-10', '500')];

    const before = computeAllocations(sales, payments);
    assert.equal(before.allocations[0].saleId, 1);

    const moved = [sale(1, '2026-09-08', '500'), sale(2, '2026-09-05', '500')];
    const after = computeAllocations(moved, payments);
    assert.equal(after.allocations[0].saleId, 2, '现在 2 号单更早，应先被核销');
  });

  it('同日多单按 id 稳定排序，重算结果可复现', () => {
    const sales = [sale(7, '2026-09-01', '100'), sale(3, '2026-09-01', '100')];
    const a = computeAllocations(sales, [pay(10, '2026-09-02', '100')]);
    const b = computeAllocations([...sales].reverse(), [pay(10, '2026-09-02', '100')]);
    assert.equal(a.allocations[0].saleId, 3);
    assert.deepEqual(a.allocations, b.allocations, '输入顺序不影响结果');
  });

  it('作废已被核销的单：释放出的款项自动流向下一张', () => {
    const payments = [pay(10, '2026-09-10', '600')];
    const withBoth = computeAllocations(
      [sale(1, '2026-08-05', '500'), sale(2, '2026-09-01', '500')],
      payments,
    );
    assert.equal(withBoth.allocations[0].saleId, 1);

    // 1 号单作废 —— 作废单不进输入
    const after = computeAllocations([sale(2, '2026-09-01', '500')], payments);
    assert.deepEqual(after.allocations, [{ paymentId: 10, saleId: 2, amountCents: 50000 }]);
    assert.equal(after.prepaidCents, yuanToCents('100'), '多出来的 100 成为预收');
  });

  it('退货负单抵减它对应的原单', () => {
    const r = computeAllocations(
      [sale(1, '2026-09-01', '1000'), sale(2, '2026-09-05', '-400', 1)],
      [pay(10, '2026-09-10', '600')],
    );
    assert.equal(r.allocations.length, 1);
    assert.equal(r.allocations[0].amountCents, yuanToCents('600'));
    assert.equal(r.outstanding.find((o) => o.saleId === 1)!.outstandingCents, 0, '1000 − 400 − 600 = 0');
  });

  it('退货把欠款抵成负数时产生预收', () => {
    const r = computeAllocations(
      [sale(1, '2026-09-01', '1000'), sale(2, '2026-09-05', '-1000', 1)],
      [pay(10, '2026-09-10', '200')],
    );
    assert.equal(r.allocations.length, 0, '没有欠款可核销');
    assert.equal(r.prepaidCents, yuanToCents('200'));
  });

  it('幂等：连续重算两次结果完全一致', () => {
    const sales = [sale(1, '2026-08-05', '1000'), sale(2, '2026-09-01', '500')];
    const payments = [pay(10, '2026-09-10', '1200')];
    const a = computeAllocations(sales, payments);
    const b = computeAllocations(sales, payments);
    assert.deepEqual(a, b);
  });

  it('没有欠款时账龄为 null', () => {
    const r = computeAllocations([sale(1, '2026-09-01', '500')], [pay(10, '2026-09-02', '500')]);
    assert.equal(agingDays(r, '2026-09-19'), null);
  });
});
