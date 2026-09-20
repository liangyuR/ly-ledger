// 发布构建不带控制台窗口。
//
// 老板不会去分辨哪个黑窗口能关、哪个不能关 —— 一旦误关，柜台上正在录的
// 那笔单就没了。Node 版为此专门写了个 .vbs 隐藏启动，这里一行属性解决。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
#[cfg(test)]
mod e2e_tests;

mod db;
mod error;
mod money;
mod paths;
mod services;
mod sql_json;
mod state;
mod validate;

use tauri::Manager;

use state::AppState;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 迁移在开窗之前跑完。跑不过就不该让界面出来 ——
            // 一个连不上库的界面只会让老板反复点，然后打电话说「软件坏了」。
            let state = AppState::boot(app.handle())?;
            app.manage(state);

            services::backup_schedule::schedule(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 商品
            commands::products_list,
            commands::product_create,
            commands::product_update,
            commands::product_delete,
            commands::products_frequent,
            commands::product_stock,
            commands::stock_overview,
            // 商品批量导入
            commands::seed_brands,
            commands::seed_import_brands,
            commands::products_parse_import,
            commands::products_import,
            commands::products_sheet_preview,
            commands::products_sheet_import,
            // 客户与供应商
            commands::customers_list,
            commands::customer_create,
            commands::suppliers_list,
            commands::supplier_create,
            // 三个正向事务 action
            commands::sales_checkout,
            commands::purchases_receive,
            commands::payments_collect,
            // 单据详情与流水
            commands::sale_detail,
            commands::sales_by_date,
            commands::purchases_recent,
            commands::purchase_detail,
            commands::product_intake,
            // 服务型收费（桌子费）
            commands::service_fees_list,
            commands::service_fees_day,
            // 逆向：作废 / 改单 / 退货
            commands::sale_void,
            commands::sale_revise,
            commands::sale_return,
            commands::purchase_void,
            commands::purchase_revise,
            commands::purchase_split,
            // 改业务日期：补录是常态（红线 2）
            commands::sale_set_date,
            commands::purchase_set_date,
            commands::payment_void,
            commands::customer_rebuild_allocations,
            // 欠款
            commands::customer_debt,
            commands::customer_statement,
            commands::customers_debts,
            // 杂项开支
            commands::expense_add,
            commands::expense_void,
            commands::expenses_month,
            // 看板与利润报表
            commands::reports_dashboard,
            commands::reports_profit,
            // 启用向导
            commands::onboarding_state,
            commands::onboarding_dismiss,
            commands::onboarding_skip_stock,
            commands::onboarding_opening_stock,
            // 备份
            commands::backup_status,
            commands::backup_now,
            commands::backup_drives,
            commands::backup_to_usb,
            // Excel 导出
            commands::export_sales,
            commands::export_ranking,
            commands::export_stale,
            commands::export_debts,
            commands::export_products,
            // 自检
            commands::health,
        ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
