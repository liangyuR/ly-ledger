import assert from 'node:assert/strict';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, it } from 'node:test';

import { openDb } from '../db';
import { migrate } from '../db/migrate';
import { toPinyin } from './pinyin';
import { importProductList, parseProductList } from './product-import';
import { importSeedBrands, listSeedBrands } from './seed-import';

let db: Database;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});

describe('拼音', () => {
  it('全拼与首字母，去掉括号', () => {
    assert.deepEqual(toPinyin('中华(硬)'), { full: 'zhonghuaying', abbr: 'zhy' });
  });

  it('mt 和 maotai 都要能命中茅台飞天', () => {
    const py = toPinyin('茅台飞天');
    assert.equal(py.full, 'maotaifeitian');
    assert.equal(py.abbr, 'mtft');
    assert.ok(py.full.startsWith('maotai'));
    assert.ok(py.abbr.startsWith('mt'));
  });

  it('空名字不炸', () => {
    assert.deepEqual(toPinyin('   '), { full: '', abbr: '' });
  });
});

describe('清单解析', () => {
  it('两段：名称 - 单位', () => {
    const r = parseProductList(db, '中华(硬) - 单包');
    assert.equal(r.rows[0].ok, true);
    assert.equal(r.rows[0].name, '中华(硬)');
    assert.equal(r.rows[0].baseUnit, '包', '「单包」的「单」要去掉');
    assert.equal(r.rows[0].packUnit, null);
    assert.equal(r.rows[0].packRatio, 1);
  });

  it('三段：名称 - 大单位 - N小单位', () => {
    const r = parseProductList(db, '中华(硬) - 条 - 10包');
    const row = r.rows[0];
    assert.equal(row.ok, true);
    assert.equal(row.baseUnit, '包');
    assert.equal(row.packUnit, '条');
    assert.equal(row.packRatio, 10);
  });

  it('全角连字符和破折号都认', () => {
    for (const sep of ['-', '－', '–', '—']) {
      const r = parseProductList(db, `泸小二 ${sep} 瓶`);
      assert.equal(r.rows[0].ok, true, `分隔符 ${sep} 应该能认`);
    }
  });

  // 这条是整个导入功能能不能被用起来的关键
  it('一行看不懂不影响其他行', () => {
    const text = [
      '中华(硬) - 条 - 10包',
      '青岛啤酒 一箱24', // 没有分隔符，看不懂
      '泸小二 - 瓶',
    ].join('\n');

    const r = parseProductList(db, text);
    assert.equal(r.summary.create, 2);
    assert.equal(r.summary.invalid, 1);
    assert.equal(r.rows[1].ok, false);
    assert.match(r.rows[1].reason!, /看不懂/);
    assert.equal(r.rows[1].raw, '青岛啤酒 一箱24', '原文要留着，老板才知道改哪行');
  });

  it('换算写不对会给出人话提示', () => {
    const r = parseProductList(db, '茅台 - 箱 - 六瓶');
    assert.equal(r.rows[0].ok, false);
    assert.match(r.rows[0].reason!, /换算看不懂/);
  });

  it('同名商品标记为已存在，不重复建', () => {
    db.prepare(`INSERT INTO products (name, category, base_unit) VALUES ('中华(硬)', 'cigarette', '包')`).run();

    const r = parseProductList(db, '中华(硬) - 条 - 10包');
    assert.equal(r.rows[0].ok, true);
    assert.equal(r.rows[0].exists, true);
    assert.equal(r.summary.skip, 1);
    assert.equal(r.summary.create, 0);
  });

  it('同一批里重复的名字也只建一次', () => {
    const r = parseProductList(db, ['泸小二 - 瓶', '泸小二 - 瓶'].join('\n'));
    assert.equal(r.summary.create, 1);
    assert.equal(r.summary.skip, 1);
  });

  it('「中华(硬) - 单包」不会和「中华(硬) - 条 - 10包」建成两个商品', () => {
    // 这两行说的是同一个商品的两种卖法，不是两个商品 ——
    // 建成两条会让库存裂成两份（docs/02）
    const r = parseProductList(db, ['中华(硬) - 条 - 10包', '中华(硬) - 单包'].join('\n'));
    assert.equal(r.summary.create, 1);
    assert.equal(r.summary.skip, 1);
  });
});

describe('清单导入', () => {
  it('落库并自动生成拼音，价格留空', () => {
    const r = importProductList(db, '中华(硬) - 条 - 10包', 'cigarette');
    assert.equal(r.created, 1);

    const p = db.prepare('SELECT * FROM products WHERE name = ?').get('中华(硬)') as {
      pinyin_full: string;
      pinyin_abbr: string;
      base_unit: string;
      pack_unit: string;
      pack_ratio: number;
      price_base_cents: number | null;
      price_pack_cents: number | null;
    };

    assert.equal(p.pinyin_full, 'zhonghuaying');
    assert.equal(p.pinyin_abbr, 'zhy');
    assert.equal(p.base_unit, '包');
    assert.equal(p.pack_unit, '条');
    assert.equal(p.pack_ratio, 10);
    assert.equal(p.price_base_cents, null, '价格各店不同，导完自己填');
    assert.equal(p.price_pack_cents, null);
  });

  it('幂等：导两遍结果一样', () => {
    const text = ['中华(硬) - 条 - 10包', '泸小二 - 瓶'].join('\n');
    const first = importProductList(db, text);
    const second = importProductList(db, text);

    assert.equal(first.created, 2);
    assert.equal(second.created, 0);
    assert.equal(second.skipped, 2);

    const n = db.prepare('SELECT count(*) AS n FROM products').get() as { n: number };
    assert.equal(n.n, 2, '导错了再导一遍就行，不会翻倍');
  });

  it('看不懂的行不落库，但不拖垮整批', () => {
    const r = importProductList(db, ['中华(硬) - 条 - 10包', '???', '泸小二 - 瓶'].join('\n'));
    assert.equal(r.created, 2);
    assert.equal(r.invalid, 1);
  });
});

describe('预置目录', () => {
  it('列出品牌与各自的商品数', () => {
    const brands = listSeedBrands(db);
    assert.ok(brands.length > 0, '目录里应该有品牌');

    const zh = brands.find((b) => b.brand === '中华');
    assert.ok(zh, '应该有中华');
    assert.ok(zh!.total > 0);
    assert.equal(zh!.alreadyImported, 0);
  });

  it('按勾选的品牌导入，不是全量', () => {
    const r = importSeedBrands(db, ['中华']);
    assert.ok(r.created > 0);

    const all = db.prepare('SELECT DISTINCT brand FROM products').all() as { brand: string }[];
    assert.deepEqual(
      all.map((x) => x.brand),
      ['中华'],
      '只导勾选的牌子 —— 全量导入会污染搜索',
    );
  });

  it('导入的是骨架，不带价格', () => {
    importSeedBrands(db, ['中华']);
    const n = db
      .prepare('SELECT count(*) AS n FROM products WHERE price_base_cents IS NOT NULL')
      .get() as { n: number };
    assert.equal(n.n, 0);
  });

  it('幂等：重复勾选同一品牌不会翻倍', () => {
    const first = importSeedBrands(db, ['中华']);
    const second = importSeedBrands(db, ['中华']);
    assert.equal(second.created, 0);
    assert.equal(second.skipped, first.created);
  });

  it('导入后再列品牌，已导入数跟上了', () => {
    importSeedBrands(db, ['中华']);
    const zh = listSeedBrands(db).find((b) => b.brand === '中华')!;
    assert.equal(zh.alreadyImported, zh.total);
  });

  it('卷烟一律 1 条 = 10 包', () => {
    importSeedBrands(db, ['中华']);
    const rows = db
      .prepare("SELECT pack_ratio FROM products WHERE category = 'cigarette'")
      .all() as { pack_ratio: number }[];
    assert.ok(rows.length > 0);
    assert.ok(
      rows.every((r) => r.pack_ratio === 10),
      '这是公开知识，可以预置；箱规则各地不同，要老板自己确认',
    );
  });
});
