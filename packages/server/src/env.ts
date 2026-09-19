/**
 * 必须在任何读取 process.env 的模块之前执行。
 * index.ts 用 `import './env'` 放在首行保证这一点。
 */
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(__dirname, '..');
const envPath = resolve(root, '.env');

if (!existsSync(envPath)) {
  console.error(
    '\n缺少 packages/server/.env\n' +
      '复制模板再启动：cp packages/server/.env.example packages/server/.env\n' +
      'APP_KEY 必须换成随机值，不要用模板里的占位符。\n',
  );
  process.exit(1);
}

config({ path: envPath });

/**
 * NocoBase 用 NODE_MODULES_PATH 作基准路径去 resolve 插件包，
 * 平时由它自己的 CLI 注入。本项目直接用 Application 启动、绕开了那个 CLI，
 * 所以得自己设 —— 不设的话 PluginManager.getPackageName 会拿到 undefined，
 * 预置插件静默加载失败，最后只建出 4 张系统表。
 *
 * 从 @nocobase/server 的实际位置反推，比写死相对路径稳：
 * <node_modules>/@nocobase/server/package.json → 上溯两级就是 node_modules。
 */
if (!process.env.NODE_MODULES_PATH) {
  const serverPkg = require.resolve('@nocobase/server/package.json');
  process.env.NODE_MODULES_PATH = resolve(dirname(serverPkg), '..', '..');
}

/** 加上自研插件的包名前缀，否则 plugin-ledger 认不出来。 */
if (!process.env.PLUGIN_PACKAGE_PREFIX) {
  process.env.PLUGIN_PACKAGE_PREFIX = '@nocobase/plugin-,@nocobase/preset-,@ly-ledger/plugin-';
}
