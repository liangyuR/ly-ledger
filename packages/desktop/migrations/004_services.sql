-- 004_services —— 服务型收费项目（桌子费、包间费这类）
--
-- 桌子费是**卖出去的东西**，不是杂项收入：它有价、有收入、可能挂客户账上，
-- 也该进当月毛利。所以它走正常销售单，不另开一张收入表 ——
-- 另开表就得在六处报表 SQL 里各加一次 UNION，而「营业额 = SUM(未作废销售单)」
-- 这条不变量会就此失效，漏改一处就是营业额少一块，且不报错（docs/02 红线 2）。
--
-- 它跟实物商品的唯一区别是**没有库存**：不进 stock_movements、没有进价、
-- 毛利就是全额。这个区别用一个标记表达，不用第二张表。
ALTER TABLE products ADD COLUMN is_service INTEGER NOT NULL DEFAULT 0
  CHECK (is_service IN (0, 1));

-- 服务没有固定售价 —— 桌子费今天 200 明天 600，是每次现填的。
-- 建一个打底，老板打开收入页就能用，不用先去商品页建档。
INSERT INTO products (name, pinyin_full, pinyin_abbr, category, base_unit, pack_ratio, is_service)
VALUES ('桌子费', 'zhuozifei', 'zzf', 'other', '次', 1, 1);
