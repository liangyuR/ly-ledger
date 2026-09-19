/**
 * 启用向导。
 *
 * 完成标准是**卖出第一笔**，不是"把表填完"（docs/04）。前三步都能跳过，
 * 第四步做不到就说明这软件在这家店里根本跑不起来 —— 那才是要暴露的问题。
 *
 * 进度一律现算，不落库。理由见 002_settings.sql：存进度就有了第二份真相，
 * 老板绕开向导自己把事做了，清单还在催他，比不做向导更糟。
 */
import type { Database } from 'better-sqlite3';

import { getFlag, setFlag } from './settings';

export const DISMISSED = 'onboarding.dismissed';
export const STOCK_SKIPPED = 'onboarding.openingStockSkipped';

export type StepKey = 'products' | 'prices' | 'stock' | 'firstSale';

export interface Step {
  key: StepKey;
  title: string;
  /** 做完了没有 */
  done: boolean;
  /** 老板主动跳过的（只有期初库存能跳） */
  skipped: boolean;
  /** 可跳过 */
  optional: boolean;
  /** 现状的一句话，比如「43 个商品」 */
  detail: string;
}

export interface OnboardingState {
  /** 全部走完（或该跳的都跳了）—— 清单不再出现 */
  complete: boolean;
  /** 老板主动关掉了清单 */
  dismissed: boolean;
  /** 一次都没卖过 —— 决定进不进全屏向导 */
  fresh: boolean;
  steps: Step[];
  doneCount: number;
}

function count(db: Database, sql: string): number {
  return (db.prepare(sql).get() as { v: number }).v;
}

export function onboardingState(db: Database): OnboardingState {
  const products = count(db, 'SELECT COUNT(*) AS v FROM products');
  const priced = count(
    db,
    `SELECT COUNT(*) AS v FROM products
      WHERE price_base_cents IS NOT NULL OR price_pack_cents IS NOT NULL`,
  );
  const purchases = count(db, 'SELECT COUNT(*) AS v FROM purchases WHERE voided_at IS NULL');
  const sales = count(
    db,
    'SELECT COUNT(*) AS v FROM sales WHERE voided_at IS NULL AND return_of_sale_id IS NULL',
  );

  const stockSkipped = getFlag(db, STOCK_SKIPPED);

  const steps: Step[] = [
    {
      key: 'products',
      title: '把你卖的牌子勾进来',
      done: products > 0,
      skipped: false,
      optional: false,
      detail: products > 0 ? `已经有 ${products} 个商品` : '一个商品都还没有',
    },
    {
      key: 'prices',
      title: '给常卖的几样填个售价',
      done: priced > 0,
      skipped: false,
      optional: false,
      detail: priced > 0 ? `${priced} 个填了价` : '还没填过价',
    },
    {
      key: 'stock',
      title: '录现在货架上的库存',
      done: purchases > 0,
      skipped: stockSkipped && purchases === 0,
      optional: true,
      detail:
        purchases > 0
          ? '已经有进货记录'
          : stockSkipped
            ? '跳过了 —— 下次进货时会自动校正'
            : '不录也能用，但头几周毛利会偏高',
    },
    {
      key: 'firstSale',
      title: '卖出第一笔',
      done: sales > 0,
      skipped: false,
      optional: false,
      detail: sales > 0 ? '卖过了，装好了' : '这一步做完才算装好',
    },
  ];

  return {
    complete: steps.every((s) => s.done || s.skipped),
    dismissed: getFlag(db, DISMISSED),
    fresh: sales === 0 && products === 0,
    steps,
    doneCount: steps.filter((s) => s.done).length,
  };
}

/** 老板说"不用了，关掉" */
export function dismissOnboarding(db: Database, on = true): void {
  setFlag(db, DISMISSED, on);
}

/** 期初库存那一步选了跳过 */
export function skipOpeningStock(db: Database, on = true): void {
  setFlag(db, STOCK_SKIPPED, on);
}
