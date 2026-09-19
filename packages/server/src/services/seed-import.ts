/**
 * 预置商品目录 —— 按品牌勾选导入。
 *
 * 这是这类软件最容易死掉的地方：一个烟酒店几百个 SKU，要求老板上线前
 * 先把商品库建全，他大概率录到第 50 个就放弃了（docs/01）。
 *
 * **绝不可全量导入。** 500 个 SKU 一股脑塞进去，搜 `zh` 会跳出一堆他
 * 根本不卖的牌子，搜索体验直接被污染。勾 15 个品牌导 60 个 SKU 刚好够用。
 */
import type { Database } from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { APP_ROOT } from '../env';
import { toPinyin } from './pinyin';

interface SeedProduct {
  name: string;
  brand: string;
  category: string;
  spec?: string;
  pinyin_full?: string;
  pinyin_abbr?: string;
  base_unit: string;
  pack_unit?: string | null;
  pack_ratio?: number;
}

interface SeedFile {
  brands: { category: string; brand: string }[];
  products: SeedProduct[];
}

/**
 * 找目录文件。打包时它会被复制进 server 包，开发时在仓库根。
 * 允许用 SEED_FILE 覆盖。
 */
function resolveSeedPath(): string {
  const fromEnv = process.env.SEED_FILE;
  const candidates = [
    fromEnv && (isAbsolute(fromEnv) ? fromEnv : resolve(APP_ROOT, fromEnv)),
    resolve(__dirname, '..', 'seed', 'products.sample.json'), // 打包后：app/../seed
    resolve(__dirname, '..', '..', 'seed', 'products.sample.json'),
    resolve(__dirname, '..', '..', '..', '..', 'seed', 'products.sample.json'), // 开发期 workspace
  ].filter(Boolean) as string[];

  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `找不到预置商品目录。找过：\n${candidates.join('\n')}\n` +
        '可用 SEED_FILE 环境变量指定。',
    );
  }
  return found;
}

let cache: SeedFile | null = null;

function loadSeed(): SeedFile {
  if (!cache) {
    cache = JSON.parse(readFileSync(resolveSeedPath(), 'utf8')) as SeedFile;
  }
  return cache;
}

export interface BrandOption {
  brand: string;
  category: string;
  /** 目录里这个牌子有多少个商品 */
  total: number;
  /** 其中已经在库里的有多少 */
  alreadyImported: number;
}

/** 列出可勾选的品牌，供首次启用时选「你店里卖哪些牌子」 */
export function listSeedBrands(db: Database): BrandOption[] {
  const seed = loadSeed();
  const existing = new Set(
    (db.prepare('SELECT name FROM products').all() as { name: string }[]).map((r) => r.name),
  );

  return seed.brands.map((b) => {
    const items = seed.products.filter((p) => p.brand === b.brand);
    return {
      brand: b.brand,
      category: b.category,
      total: items.length,
      alreadyImported: items.filter((p) => existing.has(p.name)).length,
    };
  });
}

export interface SeedImportResult {
  created: number;
  skipped: number;
  productIds: number[];
}

/**
 * 按勾选的品牌导入商品**骨架**，价格一律留空。
 *
 * 名称、规格、拼音、条/包换算都是公开知识，可以预置；
 * 进价售价各店不同、外部无从知道，必须老板自己填（docs/01）。
 *
 * 幂等：同名跳过，可重复调用。
 */
export function importSeedBrands(db: Database, brands: string[]): SeedImportResult {
  const seed = loadSeed();
  const wanted = new Set(brands);
  const picked = seed.products.filter((p) => wanted.has(p.brand));

  if (picked.length === 0) {
    return { created: 0, skipped: 0, productIds: [] };
  }

  return db.transaction((): SeedImportResult => {
    const lookup = db.prepare('SELECT id FROM products WHERE name = ?');
    const insert = db.prepare(
      `INSERT INTO products (name, pinyin_full, pinyin_abbr, category, brand, spec,
                             base_unit, pack_unit, pack_ratio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const productIds: number[] = [];
    let skipped = 0;

    for (const p of picked) {
      if (lookup.get(p.name)) {
        skipped += 1;
        continue;
      }
      // 目录里带了拼音就用它（人工校过多音字），没带才现算
      const py = p.pinyin_full && p.pinyin_abbr
        ? { full: p.pinyin_full, abbr: p.pinyin_abbr }
        : toPinyin(p.name);

      const id = insert.run(
        p.name,
        py.full,
        py.abbr,
        p.category,
        p.brand,
        p.spec ?? '',
        p.base_unit,
        p.pack_unit ?? null,
        p.pack_ratio ?? 1,
      ).lastInsertRowid;
      productIds.push(Number(id));
    }

    return { created: productIds.length, skipped, productIds };
  })();
}
