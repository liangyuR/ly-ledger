/**
 * Windows 免安装便携包。
 *
 * 产出一个可以整体复制的文件夹 —— 换电脑、重装系统只需要拷这个文件夹。
 * 不上 Docker（太重、要 WSL2、吃内存），也不装系统级 Node。
 *
 * 这一版把 Node 留在外面（runtime/node/），要店主自己解压一次。
 * 想省掉那一步的话看 sea.mjs —— 那版把 Node 焊进了 exe。
 * 两边共用的部分都在 shared.mjs。
 *
 * 跑法：npm run package
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyPayload, dirSize, mb, writeEnv, writeScripts } from './shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(HERE, 'out', '烟酒台账');

const log = (msg) => console.log(`  ${msg}`);

// ───────────────────────── 1. 清空 ─────────────────────────
console.log('\n打包烟酒台账\n');
rmSync(join(HERE, 'out'), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ───────────────────────── 2. 后端 ─────────────────────────
log('打包后端…');
await build({
  entryPoints: [join(ROOT, 'packages/server/src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(OUT, 'app', 'server.cjs'),
  // 原生模块打不进 bundle，留在外面单独拷
  external: ['better-sqlite3'],
  legalComments: 'none',
  minify: false, // 出事时要能读栈，几百 KB 不值得省
});

// ───────────────── 3. 迁移 / 原生模块 / 前端 / 预置 ─────────────────
copyPayload({ root: ROOT, out: OUT, log });

// 崩溃守护
cpSync(join(HERE, 'supervise.cjs'), join(OUT, 'supervise.cjs'));
mkdirSync(join(OUT, 'runtime'), { recursive: true });

// ───────────────────────── 4. 配置 ─────────────────────────
log('生成 .env…');
writeEnv(OUT);

// ───────────────────────── 5. 批处理 ─────────────────────────
log('生成启动脚本…');

/** 优先用包里的便携版 Node，没有就退回系统的 */
const NODE = [
  'set NODE_EXE=runtime\\node\\node.exe',
  'if not exist "%NODE_EXE%" set NODE_EXE=node',
  '',
].join('\r\n');

writeScripts(OUT, {
  nodePreamble: NODE,
  vbsPreamble: `
nodeExe = here & "\\runtime\\node\\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"
`,
  vbsRun: 'q & nodeExe & q & " " & q & here & "\\supervise.cjs" & q',
  killImage: 'node.exe',
  initCmd: '"%NODE_EXE%" app\\server.cjs --init-only',
  // 这版没有自己的 exe，指向单独的 .ico 文件
  iconLocation: '%~dp0app\\烟酒台账.ico',
  nodeCheck: true,
  readmeNote: null,
});

// ───────────────────────── 6. 收尾 ─────────────────────────
const nodeMissing = !existsSync(join(OUT, 'runtime', 'node', 'node.exe'));
writeFileSync(
  join(OUT, 'runtime', '把便携版-Node-解压到这里.txt'),
  [
    '这个文件夹要放便携版 Node.js。',
    '',
    '1. 去 https://nodejs.org/dist/ 下载 node-vXX.X.X-win-x64.zip',
    '   （版本要 ≥ 20）',
    '2. 解压后把里面的内容放成：runtime\\node\\node.exe',
    '',
    '不放也能用 —— 前提是这台电脑已经装了 Node，',
    '启动脚本会自动退回用系统里的那个。',
    '',
  ].join('\r\n'),
  'utf8',
);

const size = dirSize(OUT);
console.log('');
log(`产出：${OUT}`);
log(`大小：${mb(size)}`);
if (nodeMissing) {
  console.log('');
  log('还差便携版 Node —— 见 runtime\\把便携版-Node-解压到这里.txt');
  log('（不放也能跑，前提是目标电脑已装 Node ≥ 20）');
}
console.log('');
