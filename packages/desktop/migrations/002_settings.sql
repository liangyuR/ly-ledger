-- 002_settings —— 一张通用的设置表
--
-- 眼下只有启用向导在用，而且只存两件事：老板主动关掉了清单、老板跳过了期初库存。
--
-- 向导进度**不存这里**，一律现算（onboarding.ts）：
--   勾牌子 = 有商品、填价格 = 有商品填了价、卖第一笔 = 有销售单。
-- 存进度就会有第二份真相 —— 老板从商品页导商品、从卖货页卖第一笔，
-- 向导若看不见，就会一直催他做已经做完的事。

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
