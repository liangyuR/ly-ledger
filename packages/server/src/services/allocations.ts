/**
 * FIFO 核销 —— 纯函数，不碰数据库。
 *
 * **核销是派生结果，不是历史记录。** 输入是某客户的全部挂账单和全部收款，
 * 输出唯一确定，可以随时整体重算。
 *
 * 为什么必须这样：业务日期可改、补录是常态（红线 2），而核销按 biz_date
 * 升序 FIFO。老板补录一张上个月的单，它就该排进队列更靠前的位置 ——
 * 已写好的核销记录不会自己更新，结果是**账龄算错**，而账龄正是收款页的
 * 排序依据、老板决定先给谁打电话的依据。详见 docs/05。
 */

export interface SaleForAlloc {
  id: number;
  bizDate: string; // YYYY-MM-DD
  /** 应收，分。退货单为负 */
  totalCents: number;
  /** 本单是哪张单的退货；非退货单为 null */
  returnOfSaleId: number | null;
}

export interface PaymentForAlloc {
  id: number;
  bizDate: string;
  amountCents: number;
}

export interface Allocation {
  paymentId: number;
  saleId: number;
  amountCents: number;
}

export interface AllocResult {
  allocations: Allocation[];
  /** 分配不完的收款余额 = 预收。为 0 表示没有预收 */
  prepaidCents: number;
  /** 每张单还欠多少，用于账龄与详情页 */
  outstanding: { saleId: number; bizDate: string; outstandingCents: number }[];
}

/** (biz_date, id) 升序。带 id 是为了消除同日多单的歧义 —— 否则重算结果不稳定，单测会随机失败 */
function byDateThenId<T extends { bizDate: string; id: number }>(a: T, b: T): number {
  return a.bizDate === b.bizDate ? a.id - b.id : a.bizDate < b.bizDate ? -1 : 1;
}

/**
 * 重算某个客户的全部核销。
 *
 * 退货的处理：退货单通过 `returnOfSaleId` **直接抵减它对应的原单**，
 * 而不是当成一笔独立的"负债务"扔进 FIFO 队列。因为退货天然是针对某一单的，
 * 抵在原单上语义更准，也不需要给核销表增加"这笔核销来自退货"的字段。
 */
export function computeAllocations(
  sales: SaleForAlloc[],
  payments: PaymentForAlloc[],
): AllocResult {
  // 退货按原单归集
  const returnsBySale = new Map<number, number>();
  for (const s of sales) {
    if (s.returnOfSaleId != null) {
      returnsBySale.set(s.returnOfSaleId, (returnsBySale.get(s.returnOfSaleId) ?? 0) + s.totalCents);
    }
  }

  const debts = sales
    .filter((s) => s.returnOfSaleId == null)
    .map((s) => ({
      id: s.id,
      bizDate: s.bizDate,
      // 退货金额为负，加上去就是抵减
      remaining: s.totalCents + (returnsBySale.get(s.id) ?? 0),
    }))
    .filter((d) => d.remaining > 0)
    .sort(byDateThenId);

  const credits = [...payments].sort(byDateThenId);

  const allocations: Allocation[] = [];
  let cursor = 0;

  for (const payment of credits) {
    let left = payment.amountCents;

    while (left > 0 && cursor < debts.length) {
      const debt = debts[cursor];
      const take = Math.min(left, debt.remaining);

      allocations.push({ paymentId: payment.id, saleId: debt.id, amountCents: take });
      debt.remaining -= take;
      left -= take;

      if (debt.remaining === 0) cursor += 1;
    }

    // 收款用尽即止；所有单填满后仍有剩余 → 预收，不写核销记录
    if (left > 0) {
      const remainingPrepaid = credits
        .slice(credits.indexOf(payment) + 1)
        .reduce((sum, p) => sum + p.amountCents, 0);
      return {
        allocations,
        prepaidCents: left + remainingPrepaid,
        outstanding: debts.map((d) => ({
          saleId: d.id,
          bizDate: d.bizDate,
          outstandingCents: d.remaining,
        })),
      };
    }
  }

  return {
    allocations,
    prepaidCents: 0,
    outstanding: debts.map((d) => ({
      saleId: d.id,
      bizDate: d.bizDate,
      outstandingCents: d.remaining,
    })),
  };
}

/** 账龄：最早一张未结清单距今多少天。没有欠款返回 null */
export function agingDays(result: AllocResult, today: string): number | null {
  const earliest = result.outstanding
    .filter((o) => o.outstandingCents > 0)
    .sort((a, b) => (a.bizDate < b.bizDate ? -1 : a.bizDate > b.bizDate ? 1 : 0))[0];

  if (!earliest) return null;

  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${earliest.bizDate}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}
