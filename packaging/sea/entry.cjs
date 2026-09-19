/**
 * SEA 版的入口分派。
 *
 * 打包成单个 exe 之后，包里没有 node.exe 了，supervise.cjs 这种"再跑一个脚本"
 * 的做法就没有解释器可用。所以把守护进程也收进同一个 exe，靠参数分角色：
 *
 *   烟酒台账.exe              守护进程（它会用 --serve 把自己再拉起来）
 *   烟酒台账.exe --serve      真正的服务
 *   烟酒台账.exe --init-only  只建表然后退出（安装.bat 用）
 *
 * 两个分支都会被 esbuild 打进 bundle，但每次只执行一个。守护进程那条路径
 * 不会 require 到 fastify。
 */
'use strict';

// SEA 里 argv[0] 是 exe 自己，没有脚本路径那一项，所以从 1 开始切
const args = process.argv.slice(1);

if (args.includes('--serve') || args.includes('--init-only')) {
  require('../../packages/server/src/index.ts');
} else {
  require('./supervisor.cjs');
}
