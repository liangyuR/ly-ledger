-- 001_init —— 台账基线表结构
--
-- 金额与数量一律用整数存，不用浮点。SQLite 没有 DECIMAL，
-- 声明 decimal 也只会落成 REAL（双精度浮点），迟早在对账上咬人。
-- 单位约定（改动这里等于改动全系统，改之前先读 docs/02）：
--
--   *_cents   金额，单位「分」        1 元 = 100
--   *_e4      单位成本，单位「万分之一元」  1 元 = 10000
--   *_milli   数量，单位「千分之一」    1 包 = 1000
--
-- 单价成本用 1e-4 是因为整条进价 550 拆 10 包 = 55.0000，
-- 而整箱 333 拆 6 瓶 = 55.5000 —— 两位小数会累积误差。

PRAGMA foreign_keys = ON;

-- ───────────────────────── 商品 ─────────────────────────
CREATE TABLE products (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 同名即同商品。整条卖和单包卖是一个商品的两种卖法，不是两条记录 ——
  -- 建成两条会让库存裂成两份，且错得极隐蔽（docs/02）。
  name             TEXT    NOT NULL UNIQUE,
  pinyin_full      TEXT    NOT NULL DEFAULT '',
  pinyin_abbr      TEXT    NOT NULL DEFAULT '',
  category         TEXT    NOT NULL CHECK (category IN ('cigarette', 'liquor', 'other')),
  brand            TEXT    NOT NULL DEFAULT '',
  spec             TEXT    NOT NULL DEFAULT '',
  base_unit        TEXT    NOT NULL,                       -- 包 / 瓶，库存与成本一律以此计量
  pack_unit        TEXT,                                   -- 条 / 箱，可空
  pack_ratio       INTEGER NOT NULL DEFAULT 1 CHECK (pack_ratio >= 1),
  price_base_cents INTEGER,                                -- 单包价；NULL = 还没填价
  price_pack_cents INTEGER,                                -- 整条价，独立定价，不是单包价 × pack_ratio
  barcode          TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_weight      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),

  CHECK (pack_unit IS NOT NULL OR pack_ratio = 1)
);

CREATE INDEX idx_products_pinyin_abbr ON products (pinyin_abbr);
CREATE INDEX idx_products_pinyin_full ON products (pinyin_full);
CREATE INDEX idx_products_active      ON products (is_active, sort_weight DESC);

-- ───────────────────────── 供应商 ─────────────────────────
CREATE TABLE suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  phone      TEXT    NOT NULL DEFAULT '',
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────── 客户 ─────────────────────────
-- 只有赊账客户才建档，现金客人不建。
CREATE TABLE customers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL UNIQUE,
  pinyin_full       TEXT    NOT NULL DEFAULT '',
  pinyin_abbr       TEXT    NOT NULL DEFAULT '',
  phone             TEXT    NOT NULL DEFAULT '',
  credit_limit_cents INTEGER,                              -- NULL = 不限额
  note              TEXT    NOT NULL DEFAULT '',
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_customers_pinyin_abbr ON customers (pinyin_abbr);

-- ───────────────────────── 进货单 ─────────────────────────
CREATE TABLE purchases (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date                  TEXT    NOT NULL,              -- YYYY-MM-DD，可改，所有报表按它统计
  supplier_id               INTEGER REFERENCES suppliers (id),
  total_amount_cents        INTEGER NOT NULL,
  paid_amount_cents         INTEGER NOT NULL DEFAULT 0,    -- 一期仅记录，不参与任何计算
  voided_at                 TEXT,
  void_reason               TEXT    CHECK (void_reason IS NULL OR void_reason IN ('revised', 'mistake')),
  rev                       INTEGER NOT NULL DEFAULT 1,
  revision_of_purchase_id   INTEGER REFERENCES purchases (id),
  superseded_by_purchase_id INTEGER REFERENCES purchases (id),
  note                      TEXT    NOT NULL DEFAULT '',
  created_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_purchases_biz_date ON purchases (biz_date) WHERE voided_at IS NULL;

CREATE TABLE purchase_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id      INTEGER NOT NULL REFERENCES purchases (id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products (id),
  unit             TEXT    NOT NULL CHECK (unit IN ('base', 'pack')),
  qty_milli        INTEGER NOT NULL,                       -- 按录入单位的数量
  qty_base_milli   INTEGER NOT NULL,                       -- 换算后的基础单位数量
  unit_cost_base_e4 INTEGER NOT NULL,                      -- 按基础单位的进价
  amount_cents     INTEGER NOT NULL
);

CREATE INDEX idx_purchase_items_purchase ON purchase_items (purchase_id);
CREATE INDEX idx_purchase_items_product  ON purchase_items (product_id);

-- ───────────────────────── 销售单 ─────────────────────────
CREATE TABLE sales (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date              TEXT    NOT NULL,
  customer_id           INTEGER REFERENCES customers (id),
  settle_type           TEXT    NOT NULL CHECK (settle_type IN ('cash', 'credit')),
  original_amount_cents INTEGER NOT NULL,                  -- 折前合计
  discount_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount_cents >= 0),
  total_amount_cents    INTEGER NOT NULL,                  -- 应收
  cost_amount_cents     INTEGER NOT NULL,                  -- 成本快照，成交时冻结
  gross_profit_cents    INTEGER NOT NULL,                  -- 毛利快照
  voided_at             TEXT,
  void_reason           TEXT    CHECK (void_reason IS NULL OR void_reason IN ('revised', 'mistake')),
  rev                   INTEGER NOT NULL DEFAULT 1,
  revision_of_sale_id   INTEGER REFERENCES sales (id),
  superseded_by_sale_id INTEGER REFERENCES sales (id),
  return_of_sale_id     INTEGER REFERENCES sales (id),     -- 退货单，金额为负
  note                  TEXT    NOT NULL DEFAULT '',
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),

  -- 不变量 1：customer_id 非空 ⟺ settle_type = 'credit'
  -- 违反它会让现金单被算进欠款，或挂账单收不回来（docs/02 不变量表）
  CHECK ((customer_id IS NULL) = (settle_type = 'cash')),
  -- 不变量 3
  CHECK (total_amount_cents = original_amount_cents - discount_amount_cents),
  -- 毛利快照必须自洽
  CHECK (gross_profit_cents = total_amount_cents - cost_amount_cents)
);

CREATE INDEX idx_sales_biz_date ON sales (biz_date) WHERE voided_at IS NULL;
CREATE INDEX idx_sales_customer ON sales (customer_id, biz_date) WHERE voided_at IS NULL;

CREATE TABLE sale_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id           INTEGER NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products (id),
  unit              TEXT    NOT NULL CHECK (unit IN ('base', 'pack')),
  qty_milli         INTEGER NOT NULL,
  qty_base_milli    INTEGER NOT NULL,
  unit_price_cents  INTEGER NOT NULL,                      -- 按录入单位的成交单价，允许改价
  amount_cents      INTEGER NOT NULL,
  unit_cost_base_e4 INTEGER NOT NULL,                      -- 成交那一刻的加权成本快照，冻结不可变
  cost_amount_cents INTEGER NOT NULL
);

CREATE INDEX idx_sale_items_sale    ON sale_items (sale_id);
CREATE INDEX idx_sale_items_product ON sale_items (product_id);

-- ───────────────────────── 收款 ─────────────────────────
CREATE TABLE payments (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date                 TEXT    NOT NULL,
  customer_id              INTEGER NOT NULL REFERENCES customers (id),
  amount_cents             INTEGER NOT NULL CHECK (amount_cents > 0),
  method                   TEXT    NOT NULL CHECK (method IN ('cash', 'wechat', 'alipay', 'transfer')),
  source                   TEXT    NOT NULL DEFAULT 'collect' CHECK (source IN ('collect', 'partial_pay')),
  voided_at                TEXT,
  void_reason              TEXT    CHECK (void_reason IS NULL OR void_reason IN ('revised', 'mistake')),
  rev                      INTEGER NOT NULL DEFAULT 1,
  revision_of_payment_id   INTEGER REFERENCES payments (id),
  superseded_by_payment_id INTEGER REFERENCES payments (id),
  note                     TEXT    NOT NULL DEFAULT '',
  created_at               TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_payments_customer ON payments (customer_id, biz_date) WHERE voided_at IS NULL;

-- 核销明细。**这是派生表，不是流水。**
-- 可以整体删除并从 sales + payments 重算，结果唯一确定。
-- 任何影响输入的操作（作废、修改、补录、改 biz_date、退货）之后
-- 必须对相关客户全量重跑。详见 docs/05。
CREATE TABLE payment_allocations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id   INTEGER NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
  sale_id      INTEGER NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0)
);

CREATE INDEX idx_alloc_payment ON payment_allocations (payment_id);
CREATE INDEX idx_alloc_sale    ON payment_allocations (sale_id);

-- ───────────────────────── 库存流水 ─────────────────────────
-- 唯一真相来源。只 INSERT，永不 UPDATE / DELETE。
CREATE TABLE stock_movements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date          TEXT    NOT NULL,
  product_id        INTEGER NOT NULL REFERENCES products (id),
  type              TEXT    NOT NULL CHECK (type IN ('purchase', 'sale', 'return', 'void', 'adjust', 'stocktake')),
  qty_base_milli    INTEGER NOT NULL,                      -- 带符号：入库为正，出库为负
  unit_cost_base_e4 INTEGER NOT NULL,
  ref_type          TEXT    NOT NULL,
  ref_id            INTEGER NOT NULL,
  balance_after_milli INTEGER NOT NULL,                    -- 变动后结存，便于回溯排查
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_movements_product ON stock_movements (product_id, id);
CREATE INDEX idx_movements_ref     ON stock_movements (ref_type, ref_id);

-- ───────────────────────── 结存快照 ─────────────────────────
-- stock_movements 的物化视图，任何时候都能从流水重算出来。
CREATE TABLE inventory (
  product_id       INTEGER PRIMARY KEY REFERENCES products (id),
  qty_base_milli   INTEGER NOT NULL DEFAULT 0,             -- 允许为负，不做写入拦截（红线 1）
  avg_cost_base_e4 INTEGER NOT NULL DEFAULT 0 CHECK (avg_cost_base_e4 >= 0),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
