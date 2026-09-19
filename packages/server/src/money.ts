/**
 * 金额与数量的单位换算。
 *
 * 全系统只有两个地方允许在「人看的小数」和「库里的整数」之间转换：
 * 入参解析时，和出参格式化时。中间一律整数 —— 见 docs/02 单位约定。
 *
 *   分     _cents   1 元 = 100
 *   万分之一元 _e4  1 元 = 10000
 *   千分之一  _milli 1 包 = 1000
 */

/** 解析十进制字符串为放大 10^scale 倍的整数，不经过浮点 */
function parseDecimal(input: string | number, scale: number, label: string): number {
  const text = typeof input === 'number' ? String(input) : input.trim();

  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`${label} 不是合法数字：${JSON.stringify(input)}`);
  }

  const negative = text.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? text.slice(1) : text).split('.');

  if (fracPart.length > scale) {
    throw new Error(
      `${label} 的小数位超出精度：${text}，最多 ${scale} 位。` +
        `不做静默截断 —— 悄悄丢掉的那一位迟早变成对不上的账。`,
    );
  }

  const padded = fracPart.padEnd(scale, '0');
  const value = Number(intPart + padded);

  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} 超出安全整数范围：${text}`);
  }

  return negative ? -value : value;
}

/** 格式化放大 10^scale 倍的整数为十进制字符串 */
function formatDecimal(value: number, scale: number, trimTrailingZeros: boolean): string {
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  let fracPart = digits.slice(digits.length - scale);

  if (trimTrailingZeros) {
    fracPart = fracPart.replace(/0+$/, '');
  }

  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${body}` : body;
}

// ── 金额：元 ↔ 分 ────────────────────────────────────────────
export const yuanToCents = (v: string | number) => parseDecimal(v, 2, '金额');
export const centsToYuan = (v: number) => formatDecimal(v, 2, false);

// ── 单位成本：元 ↔ 万分之一元 ─────────────────────────────────
export const yuanToE4 = (v: string | number) => parseDecimal(v, 4, '单位成本');
export const e4ToYuan = (v: number) => formatDecimal(v, 4, false);

// ── 数量：个 ↔ 千分之一 ───────────────────────────────────────
export const qtyToMilli = (v: string | number) => parseDecimal(v, 3, '数量');
export const milliToQty = (v: number) => formatDecimal(v, 3, true);

/**
 * 四舍五入的整数除法，零远离（-0.5 → -1，0.5 → 1）。
 *
 * 用 BigInt 是必须的：加权成本的中间量是 数量(milli) × 单价(e4)，
 * 量级到 10^17，早就越过 Number.MAX_SAFE_INTEGER（约 9×10^15）。
 * 用普通数字算，误差不会报错，只会让成本悄悄偏掉。
 */
export function divRound(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) {
    throw new Error('除数为零');
  }

  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;

  const quotient = a / b;
  const remainder = a % b;
  const rounded = remainder * 2n >= b ? quotient + 1n : quotient;

  const result = Number(negative ? -rounded : rounded);
  if (!Number.isSafeInteger(result)) {
    throw new Error(`计算结果超出安全整数范围：${rounded}`);
  }
  return result;
}
