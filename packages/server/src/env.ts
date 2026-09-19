/** 必须最先执行：index.ts 用 `import './env'` 放在首行。 */
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 应用根目录：开发期是 packages/server，打包后是便携包根目录。
 *
 * 所有相对路径（数据库、备份、前端产物、预置目录）都按它解析，
 * **不按 process.cwd()** —— cwd 取决于谁怎么启动的，
 * 双击 .bat 和从任务计划里拉起就不是同一个值。
 */
export const APP_ROOT = resolve(__dirname, '..');

const envPath = resolve(APP_ROOT, '.env');

if (existsSync(envPath)) {
  config({ path: envPath });
}
