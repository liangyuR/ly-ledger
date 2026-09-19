/**
 * 移动加权平均成本 —— 纯函数，不碰数据库。
 *
 * 这是全系统**错了最难发现**的一段：算错不报错，只让毛利慢慢偏掉，
 * 老板要到月底才觉得数字不对，那时已无从追查。所以它必须是纯函数，
 * 并且有测试钉死每个分支（docs/03 测试策略）。
 *
 * 单位：数量 milli（千分之一），单价 e4（万分之一元）。
 */
import { divRound } from '../money';

export interface Stock {
  qtyMilli: number;
  avgCostE4: number;
}

export interface CostWarning {
  code: 'negative_avg_clamped';
  message: string;
}

export interface CostResult extends Stock {
  warnings: CostWarning[];
}

/**
 * 进货后的新结存与新均价。
 *
 * **必须显式处理 old_qty <= 0 的分支。** 因为允许负库存（红线 1），
 * 标准加权公式在负库存上会算出负成本或除零。
 */
export function applyPurchase(prev: Stock, inQtyMilli: number, inCostE4: number): CostResult {
  if (inQtyMilli <= 0) {
    throw new Error(`进货数量必须为正，收到 ${inQtyMilli}`);
  }
  if (inCostE4 < 0) {
    throw new Error(`进价不能为负，收到 ${inCostE4}`);
  }

  const newQty = prev.qtyMilli + inQtyMilli;

  // 进完仍为负或归零 —— 旧成本没有参考意义，直接用本次进价
  if (newQty <= 0) {
    return { qtyMilli: newQty, avgCostE4: inCostE4, warnings: [] };
  }

  // 进货前是负库存或零库存 —— 旧均价无效，不能套加权公式
  if (prev.qtyMilli <= 0) {
    return { qtyMilli: newQty, avgCostE4: inCostE4, warnings: [] };
  }

  const total = BigInt(prev.qtyMilli) * BigInt(prev.avgCostE4) + BigInt(inQtyMilli) * BigInt(inCostE4);
  return {
    qtyMilli: newQty,
    avgCostE4: divRound(total, BigInt(newQty)),
    warnings: [],
  };
}

/**
 * 销售后的新结存。**均价不变。**
 *
 * 库存变负后继续销售，仍沿用最后已知的均价估算毛利。这是有偏差的，
 * 但比拒绝记账好 —— 下次进货时成本会自动校正回来（红线 1）。
 */
export function applySale(prev: Stock, outQtyMilli: number): CostResult {
  if (outQtyMilli <= 0) {
    throw new Error(`出库数量必须为正，收到 ${outQtyMilli}`);
  }
  return {
    qtyMilli: prev.qtyMilli - outQtyMilli,
    avgCostE4: prev.avgCostE4,
    warnings: [],
  };
}

/**
 * 作废一张进货单时的反向调整。
 *
 * 只调整当前库存和均价，**不回溯修改任何历史成本快照** ——
 * 那会违反红线 3，让上个月已经看过的利润数字发生变化（docs/05）。
 */
export function reversePurchase(prev: Stock, voidQtyMilli: number, voidCostE4: number): CostResult {
  if (voidQtyMilli <= 0) {
    throw new Error(`作废数量必须为正，收到 ${voidQtyMilli}`);
  }

  const newQty = prev.qtyMilli - voidQtyMilli;

  if (newQty <= 0) {
    // 无从推算，保持原均价
    return { qtyMilli: newQty, avgCostE4: prev.avgCostE4, warnings: [] };
  }

  const total = BigInt(prev.qtyMilli) * BigInt(prev.avgCostE4) - BigInt(voidQtyMilli) * BigInt(voidCostE4);
  const avg = divRound(total, BigInt(newQty));

  // 真实可能发生：作废的是一笔高价进货，而此后又进了大量低价货把均价拉低，
  // 反算就会得到负数。必须 clamp 并告警 —— 否则后续毛利全错且无人察觉。
  if (avg < 0) {
    return {
      qtyMilli: newQty,
      avgCostE4: 0,
      warnings: [
        {
          code: 'negative_avg_clamped',
          message:
            `作废进货后反算出负成本（${avg}），已归零。` +
            `此后该商品的毛利会偏高，直到下次进货把均价拉回合理区间。`,
        },
      ],
    };
  }

  return { qtyMilli: newQty, avgCostE4: avg, warnings: [] };
}
