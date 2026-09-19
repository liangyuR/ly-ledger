/**
 * better-sqlite3 在 SEA 里的加载垫片。
 *
 * 原生模块（.node）打不进 SEA 的 blob，必须留在磁盘上。而 SEA 主脚本里的
 * require() 只认内置模块 —— 它解析不到 node_modules。所以要用 createRequire
 * 手工造一个能解析磁盘的 require。
 *
 * 基准点用 process.execPath（= app/烟酒台账.exe），于是解析目录是 app/，
 * 正好命中 app/node_modules/better-sqlite3 —— 和非 SEA 包的布局一模一样。
 *
 * better-sqlite3 自己是普通 CJS 模块，被真实模块系统加载后，它内部靠
 * __dirname 找 prebuilds/win32-x64.node 的逻辑不受任何影响。
 */
'use strict';

const { createRequire } = require('node:module');

module.exports = createRequire(process.execPath)('better-sqlite3');
