/**
 * Excel 导出。
 *
 * 三个入口都是一个按钮直接下 .xlsx，**不弹导出配置** ——
 * 老板要的是一份能直接发给会计、或者年底跟单位客户对账的表，
 * 不是一个导出向导（docs/04）。
 *
 * 金额在表里写成**数字**而不是字符串，否则会计打开后没法求和。
 * 库里是整数分，这里除以 100 交给 Excel —— 这是唯一允许出现浮点的地方，
 * 因为它已经离开系统了。
 */
import type { Database } from 'better-sqlite3';
import writeXlsxFile from 'write-excel-file/node';

import { centsToYuan, milliToQty } from '../money';
import { listDebts, today } from './reports';
import { productRanking, staleProducts } from './profit-reports';

/** 表格单元格能装的东西。查询结果统一按这个形状看待 */
type Cell = string | number | null;
type SheetRow = Record<string, Cell>;

interface Column {
  column: string;
  type?: typeof String | typeof Number;
  value: (r: SheetRow) => Cell;
  width?: number;
  format?: string;
}

const MONEY = '#,##0.00';

/** 分 → 元。这是唯一允许出现浮点的地方 —— 数据已经离开系统了。
 *  金额写成数字而不是字符串，否则会计打开后没法求和 */
const yuan = (cents: Cell) => Number(cents ?? 0) / 100;
const text = (v: Cell) => (v == null ? '' : String(v));

async function build(rows: SheetRow[], columns: Column[]): Promise<Buffer> {
  // v4 的列定义：column → header，取值/类型/格式收进 cell() 函数
  const spec = columns.map((c) => ({
    header: { value: c.column, fontWeight: 'bold' as const },
    width: c.width ?? 16,
    cell: (r: SheetRow) => {
      const raw = c.value(r);
      // 数字列遇到空值要给 null，给空字符串会被当成文本，整列格式就废了
      const value = c.type === Number && (raw === '' || raw == null) ? null : raw;
      return { value, type: c.type ?? String, format: c.format };
    },
  }));

  // v4 不再看 buffer: true 这类选项，而是返回一个带 toBuffer/toFile/toStream 的对象
  return writeXlsxFile(rows, { columns: spec }).toBuffer();
}

export interface Export {
  filename: string;
  buffer: Buffer;
}

/** 本月明细：每一笔销售 + 成本快照 + 毛利 */
export async function exportSales(db: Database, month?: string): Promise<Export> {
  const m = month ?? today(db).slice(0, 7);

  const rows = db
    .prepare(
      `SELECT s.id, s.biz_date, s.settle_type, c.name AS customer,
              p.name AS product, si.qty_milli, si.unit, si.unit_price_cents,
              si.amount_cents, si.cost_amount_cents,
              (si.amount_cents - si.cost_amount_cents) AS profit_cents,
              s.discount_amount_cents, s.note
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
         JOIN products p ON p.id = si.product_id
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.voided_at IS NULL AND substr(s.biz_date, 1, 7) = ?
        ORDER BY s.biz_date, s.id, si.id`,
    )
    .all(m) as unknown as SheetRow[];

  const buffer = await build(rows, [
    { column: '单号', value: (r) => `#${r['id']}`, width: 10 },
    { column: '业务日期', value: (r) => text(r['biz_date']), width: 13 },
    { column: '结算', value: (r) => (r['settle_type'] === 'cash' ? '现金' : '挂账'), width: 8 },
    { column: '客户', value: (r) => text(r['customer']), width: 12 },
    { column: '商品', value: (r) => text(r['product']), width: 20 },
    { column: '数量', value: (r) => milliToQty(Number(r['qty_milli'])), width: 9 },
    { column: '单位', value: (r) => (r['unit'] === 'pack' ? '整包' : '单件'), width: 8 },
    { column: '单价', type: Number, format: MONEY, value: (r) => yuan(r['unit_price_cents']) },
    { column: '小计', type: Number, format: MONEY, value: (r) => yuan(r['amount_cents']) },
    { column: '成本', type: Number, format: MONEY, value: (r) => yuan(r['cost_amount_cents']) },
    { column: '毛利', type: Number, format: MONEY, value: (r) => yuan(r['profit_cents']) },
    { column: '整单抹零', type: Number, format: MONEY, value: (r) => yuan(r['discount_amount_cents']) },
    { column: '备注', value: (r) => text(r['note']), width: 20 },
  ]);

  return { filename: `销售明细-${m}.xlsx`, buffer };
}

/** 欠款表：谁欠多少、账龄、最早一笔 */
export async function exportDebts(db: Database): Promise<Export> {
  const d = listDebts(db);
  const rows = [
    ...d.owing.map((r) => ({ ...r, kind: '欠款' })),
    ...d.prepaid.map((r) => ({ ...r, kind: '预收' })),
  ];

  const buffer = await build(rows as unknown as SheetRow[], [
    { column: '客户', value: (r) => text(r['name']), width: 16 },
    { column: '类型', value: (r) => text(r['kind']), width: 8 },
    {
      column: '金额',
      type: Number,
      format: MONEY,
      value: (r) => yuan(Math.abs(Number(r['netDebtCents']))),
    },
    { column: '账龄（天）', type: Number, value: (r) => r['agingDays'] ?? '', width: 12 },
    { column: '最早未结清', value: (r) => text(r['earliestUnpaidDate']), width: 14 },
  ]);

  return { filename: `欠款表-${today(db)}.xlsx`, buffer };
}

/**
 * 全部商品与价格。
 * **这份同时就是导入模板** —— 导出、填好、再导回来，闭环不用另做一份。
 */
export async function exportProducts(db: Database): Promise<Export> {
  const rows = db
    .prepare(
      `SELECT p.*, COALESCE(i.qty_base_milli, 0) AS qty, COALESCE(i.avg_cost_base_e4, 0) AS cost
         FROM products p LEFT JOIN inventory i ON i.product_id = p.id
        WHERE p.is_active = 1
        ORDER BY p.brand, p.name`,
    )
    .all() as unknown as SheetRow[];

  const buffer = await build(rows, [
    { column: '商品名', value: (r) => text(r['name']), width: 22 },
    { column: '品牌', value: (r) => text(r['brand']), width: 12 },
    { column: '规格', value: (r) => text(r['spec']), width: 14 },
    { column: '基础单位', value: (r) => text(r['base_unit']), width: 10 },
    { column: '包装单位', value: (r) => text(r['pack_unit']), width: 10 },
    { column: '换算', type: Number, value: (r) => Number(r['pack_ratio']), width: 8 },
    {
      column: '整包售价',
      type: Number,
      format: MONEY,
      value: (r) => (r['price_pack_cents'] == null ? '' : yuan(r['price_pack_cents'])),
    },
    {
      column: '单件售价',
      type: Number,
      format: MONEY,
      value: (r) => (r['price_base_cents'] == null ? '' : yuan(r['price_base_cents'])),
    },
    { column: '当前库存', value: (r) => milliToQty(Number(r['qty'])), width: 11 },
    {
      column: '加权成本',
      type: Number,
      format: '#,##0.0000',
      value: (r) => Number(r['cost']) / 10000,
    },
    { column: '拼音', value: (r) => text(r['pinyin_abbr']), width: 12 },
  ]);

  return { filename: `商品与价格-${today(db)}.xlsx`, buffer };
}

/** 单品毛利排行 + 滞销预警，两张表做成一个文件不现实，这里只出排行 */
export async function exportRanking(db: Database, month?: string): Promise<Export> {
  const m = month ?? today(db).slice(0, 7);
  const rows = productRanking(db, m, 200) as unknown as unknown as SheetRow[];

  const buffer = await build(rows, [
    { column: '商品', value: (r) => text(r['name']), width: 22 },
    { column: '销量', value: (r) => milliToQty(Number(r['qtyBaseMilli'])), width: 11 },
    { column: '销售额', type: Number, format: MONEY, value: (r) => yuan(r['revenueCents']) },
    { column: '毛利', type: Number, format: MONEY, value: (r) => yuan(r['profitCents']) },
    {
      column: '毛利率',
      value: (r) => (r['marginPermille'] == null ? '' : `${(Number(r['marginPermille']) / 10).toFixed(1)}%`),
      width: 10,
    },
  ]);

  return { filename: `单品毛利排行-${m}.xlsx`, buffer };
}

/** 滞销预警：压了多少钱 */
export async function exportStale(db: Database, days = 90): Promise<Export> {
  const rows = staleProducts(db, days) as unknown as unknown as SheetRow[];

  const buffer = await build(rows, [
    { column: '商品', value: (r) => text(r['name']), width: 22 },
    { column: '库存', value: (r) => `${milliToQty(Number(r['qtyBaseMilli']))} ${text(r['baseUnit'])}`, width: 12 },
    { column: '压了多少钱', type: Number, format: MONEY, value: (r) => yuan(r['valueCents']) },
    { column: '最后卖出', value: (r) => text(r['lastSoldDate']) || '从没卖过', width: 14 },
    { column: '闲置天数', type: Number, value: (r) => r['idleDays'] ?? '', width: 11 },
  ]);

  return { filename: `滞销预警-${today(db)}.xlsx`, buffer };
}

/** 供调试：把分转成人读的字符串 */
export const fmt = centsToYuan;
