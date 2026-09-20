-- 003_expenses —— 杂项开支
--
-- 房租、水电、伙食、运费这类钱，跟商品和库存没有任何关系：
-- 它们不进 stock_movements，不影响加权成本，也不改任何一张单的毛利。
-- 所以这里是一张**独立的流水表**，不往 purchases 里塞 ——
-- 塞进去就得给 purchase_items 编一个假商品，那是账烂掉的开始。
--
-- 金额同样用整数分，口径见 001_init 开头那段。

CREATE TABLE expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date     TEXT    NOT NULL,                        -- YYYY-MM-DD，按它归月
  -- 自由文本不做枚举：每家店的名目都不一样，界面给几个常用的点一下就填上，
  -- 但不拦别的写法 —— 拦了老板就会把「摩托车加油」记成「其他」，记了等于没记
  category     TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  note         TEXT    NOT NULL DEFAULT '',
  -- 钱的记录不物理删除，跟销售、进货、收款同一套规矩（docs/05）
  voided_at    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_expenses_biz_date ON expenses (biz_date) WHERE voided_at IS NULL;
