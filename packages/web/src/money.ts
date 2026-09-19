/**
 * 前端的金额换算，和后端同构：**整数分，不碰浮点**。
 *
 * 前端只在两处需要算钱：购物车小计和合计的实时预览。
 * 这两个数最终都会被后端重算并返回权威值 —— 前端算只是为了让老板
 * 在按 F8 之前就看到数。即便如此也不用 number 乘除：
 * `Number('1.15') * 100` 等于 114.99999999999999。
 */

/** "55.5" → 5550。小数超两位直接报错，不静默截断 */
export function yuanToCents(input: string | number): number {
  const text = String(input).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`金额不是合法数字：${text}`);

  const negative = text.startsWith('-');
  const [int, frac = ''] = (negative ? text.slice(1) : text).split('.');
  if (frac.length > 2) throw new Error(`金额最多两位小数：${text}`);

  const value = Number(int + frac.padEnd(2, '0'));
  return negative ? -value : value;
}

/** 5550 → "55.50" */
export function centsToYuan(cents: number): string {
  const negative = cents < 0;
  const digits = String(Math.abs(cents)).padStart(3, '0');
  const body = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return negative ? `-${body}` : body;
}

/** 数量 × 单价 → 分。数量按千分之一取整，避免 0.1 那类输入产生浮点 */
export function lineAmountCents(qty: string | number, unitPriceCents: number): number {
  const text = String(qty).trim();
  if (!/^\d+(\.\d{1,3})?$/.test(text)) throw new Error(`数量不是合法数字：${text}`);
  const [int, frac = ''] = text.split('.');
  const milli = Number(int + frac.padEnd(3, '0'));
  return Math.round((milli * unitPriceCents) / 1000);
}

/** 带千分位，给大数字用 */
export function formatYuan(cents: number): string {
  const [int, frac] = centsToYuan(cents).split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}
