/**
 * 商品批量导入 —— 手工清单。
 *
 * 三条硬要求（docs/04）：
 *   1. 单行看不懂不能让整批失败。失败行标出来，允许改完再导
 *   2. 同名商品跳过，不重复建。可以反复导，导错了再导一遍就行
 *   3. 价格不在这里填。导完去商品页批量填，两件事不要混在一屏
 */
import type { Database } from 'better-sqlite3';

import { toPinyin } from './pinyin';

export interface ParsedRow {
  /** 原文，让老板能对上是哪一行 */
  raw: string;
  ok: boolean;
  /** 解析失败的原因，人话 */
  reason?: string;
  name?: string;
  baseUnit?: string;
  packUnit?: string | null;
  packRatio?: number;
  pinyinFull?: string;
  pinyinAbbr?: string;
  /** 库里已经有同名商品 */
  exists?: boolean;
  existingId?: number;
}

export interface ParseResult {
  rows: ParsedRow[];
  summary: { create: number; skip: number; invalid: number };
}

/** 分隔符：半角/全角连字符、破折号都认 */
const SEP = /\s*[-–—－]\s*/;

/** 「单包」「单瓶」→「包」「瓶」 */
const stripSingle = (u: string) => u.replace(/^单/, '').trim();

/** 「10包」→ { ratio: 10, unit: '包' } */
function parseRatio(text: string): { ratio: number; unit: string } | null {
  const m = text.trim().match(/^(\d+)\s*(.+)$/);
  if (!m) return null;
  const ratio = Number(m[1]);
  const unit = m[2].trim();
  if (!Number.isInteger(ratio) || ratio < 1 || !unit) return null;
  return { ratio, unit };
}

function parseLine(raw: string): ParsedRow {
  const line = raw.trim();
  if (!line) return { raw, ok: false, reason: '空行' };

  const parts = line.split(SEP).filter((p) => p.length > 0);

  if (parts.length < 2) {
    return {
      raw,
      ok: false,
      reason: '看不懂，缺少单位。写成「中华(硬) - 单包」或「中华(硬) - 条 - 10包」',
    };
  }
  if (parts.length > 3) {
    return { raw, ok: false, reason: '分段太多，最多「名称 - 大单位 - 换算」三段' };
  }

  const name = parts[0].trim();
  if (!name) return { raw, ok: false, reason: '商品名为空' };

  const py = toPinyin(name);

  // 两段：名称 - 单位
  if (parts.length === 2) {
    const unit = stripSingle(parts[1]);
    if (!unit) return { raw, ok: false, reason: '单位为空' };
    return {
      raw,
      ok: true,
      name,
      baseUnit: unit,
      packUnit: null,
      packRatio: 1,
      pinyinFull: py.full,
      pinyinAbbr: py.abbr,
    };
  }

  // 三段：名称 - 大单位 - N小单位
  const packUnit = stripSingle(parts[1]);
  const ratio = parseRatio(parts[2]);
  if (!packUnit) return { raw, ok: false, reason: '包装单位为空' };
  if (!ratio) {
    return { raw, ok: false, reason: `换算看不懂：「${parts[2]}」。应写成「10包」这样` };
  }

  return {
    raw,
    ok: true,
    name,
    baseUnit: ratio.unit,
    packUnit,
    packRatio: ratio.ratio,
    pinyinFull: py.full,
    pinyinAbbr: py.abbr,
  };
}

/** 解析清单，不落库。用于导入前预览 */
export function parseProductList(db: Database, text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lookup = db.prepare('SELECT id FROM products WHERE name = ?');

  // 同一批里重复的名字也算已存在，否则会撞唯一约束
  const seen = new Set<string>();
  const rows = lines.map((line) => {
    const row = parseLine(line);
    if (!row.ok || !row.name) return row;

    const existing = lookup.get(row.name) as { id: number } | undefined;
    if (existing) {
      return { ...row, exists: true, existingId: existing.id };
    }
    if (seen.has(row.name)) {
      return { ...row, exists: true };
    }
    seen.add(row.name);
    return row;
  });

  return {
    rows,
    summary: {
      create: rows.filter((r) => r.ok && !r.exists).length,
      skip: rows.filter((r) => r.ok && r.exists).length,
      invalid: rows.filter((r) => !r.ok).length,
    },
  };
}

export interface ImportResult {
  created: number;
  skipped: number;
  invalid: number;
  productIds: number[];
}

/**
 * 按解析结果落库。**幂等**：同名跳过，可以反复导。
 *
 * 价格一律留空 —— 各店不同，导完在商品页批量填。
 */
export function importProductList(db: Database, text: string, category = 'other'): ImportResult {
  return db.transaction((): ImportResult => {
    const parsed = parseProductList(db, text);
    const insert = db.prepare(
      `INSERT INTO products (name, pinyin_full, pinyin_abbr, category, base_unit, pack_unit, pack_ratio)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const productIds: number[] = [];
    for (const row of parsed.rows) {
      if (!row.ok || row.exists) continue;
      const id = insert.run(
        row.name,
        row.pinyinFull ?? '',
        row.pinyinAbbr ?? '',
        category,
        row.baseUnit,
        row.packUnit ?? null,
        row.packRatio ?? 1,
      ).lastInsertRowid;
      productIds.push(Number(id));
    }

    return {
      created: productIds.length,
      skipped: parsed.summary.skip,
      invalid: parsed.summary.invalid,
      productIds,
    };
  })();
}
