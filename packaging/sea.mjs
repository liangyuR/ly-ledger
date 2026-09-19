/**
 * Windows 免安装便携包 —— SEA 版。
 *
 * 和 build.mjs 的区别只有一个：不再往包里塞一个 runtime/node/ 目录，
 * 而是把 Node 运行时和后端 bundle 焊成一个 exe（Node 的 single executable
 * application）。店主那边少一个"请自己去 nodejs.org 下载解压"的步骤。
 * 两边共用的部分都在 shared.mjs。
 *
 * 关键发现：SEA 里 __dirname = exe 所在目录，与 cwd 无关。所以只要把 exe
 * 放在 app/ 下（就是原来 server.cjs 的位置），env.ts 的 APP_ROOT、migrate.ts
 * 的 migrations 路径、app.ts 的 web 路径**全部零改动**继续成立。
 *
 * 跑法：npm run package:sea
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyPayload, dirSize, mb, writeEnv, writeScripts } from './shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(HERE, 'out-sea', '烟酒台账');
const BUILD = join(HERE, 'out-sea', '.build');
const EXE_NAME = '烟酒台账.exe';

const log = (msg) => console.log(`  ${msg}`);

/** 找 signtool。找不到也能继续，只是 exe 的签名会是坏的 —— 见下面注释 */
function findSigntool() {
  const base = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (!existsSync(base)) return null;
  const versions = readdirSync(base)
    .filter((d) => /^10\./.test(d))
    .sort()
    .reverse();
  for (const v of versions) {
    const p = join(base, v, 'x64', 'signtool.exe');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 摘掉 node.exe 自带的微软签名。
 *
 * 会偶发失败：exe 有 92 MB，刚拷完 Defender 正在扫它，signtool 打不开来写。
 * 试几次基本就过了，所以这里重试而不是直接崩 —— 打一次包等好几分钟，
 * 栽在一个必然能重试成功的地方最让人恼火。
 */
function stripSignature(signtool, exe, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      execFileSync(signtool, ['remove', '/s', exe], { stdio: 'ignore' });
      return true;
    } catch {
      if (i === attempts) return false;
      // 同步等一下，让扫描先过去。这是构建脚本，卡住主线程无所谓
      const until = Date.now() + 1000 * i;
      while (Date.now() < until) {
        /* 空转 */
      }
    }
  }
  return false;
}

// ───────────────────────── 1. 清空 ─────────────────────────
console.log('\n打包烟酒台账（SEA 单 exe 版）\n');
rmSync(join(HERE, 'out-sea'), { recursive: true, force: true });
mkdirSync(join(OUT, 'app'), { recursive: true });
mkdirSync(BUILD, { recursive: true });

// ───────────────────────── 2. 后端 bundle ─────────────────────────
log('打包后端…');
const bundlePath = join(BUILD, 'bundle.cjs');
await build({
  // 入口是分派器：一个 exe 既当服务也当守护进程
  entryPoints: [join(HERE, 'sea', 'entry.cjs')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: bundlePath,
  // 原生模块进不了 blob，用垫片在运行时从磁盘加载
  alias: { 'better-sqlite3': join(HERE, 'sea', 'sqlite-shim.cjs') },
  legalComments: 'none',
  minify: false, // 出事时要能读栈
});
log(`  bundle：${mb(statSync(bundlePath).size)}`);

// ───────────────────── 3. 生成 blob ─────────────────────
log('生成 SEA blob…');
const seaConfig = join(BUILD, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: bundlePath,
      output: join(BUILD, 'sea.blob'),
      // 不然每次启动都往 stderr 打一行实验性功能警告，老板会当成报错
      disableExperimentalSEAWarning: true,
      // 预编译成字节码，启动快一点
      useCodeCache: true,
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// ───────────────────── 4. 做出 exe ─────────────────────
// 顺序要紧：摘签名 → 换图标 → 注入 blob。
// rcedit 改的是 PE 的资源段，会重排文件布局；blob 是追加在文件末尾的，
// 先注入再 rcedit 会把它搬走或截断。
log('制作可执行文件…');
const exePath = join(OUT, 'app', EXE_NAME);
cpSync(process.execPath, exePath);

// node.exe 是微软签过名的，往后面追加数据会让签名校验失败。
// 先把签名摘掉，Windows 就当它是个普通未签名程序 —— 比留一个"坏签名"干净：
// 坏签名在某些安全软件眼里比没签名更可疑。
const signtool = findSigntool();
if (!signtool) {
  log('  [!] 没找到 signtool，exe 会带一个坏签名（能跑，但不干净）');
} else if (stripSignature(signtool, exePath)) {
  log('  已摘除 node.exe 原有签名');
} else {
  // 摘不掉不值得让整包失败：坏签名的 exe 照样能跑，只是不干净
  log('  [!] 摘除签名失败（试了 3 次），exe 会带一个坏签名（能跑，但不干净）');
}

log('  换图标、写版本信息…');
execFileSync(
  join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  [
    exePath,
    '--set-icon',
    join(HERE, 'icon', '烟酒台账.ico'),
    // 属性面板里看到的东西。不写的话这里显示的是 "Node.js JavaScript Runtime"，
    // 店主要是哪天右键看了一眼，会以为装错了程序
    '--set-version-string', 'ProductName', '烟酒台账',
    '--set-version-string', 'FileDescription', '烟酒台账',
    '--set-version-string', 'CompanyName', '烟酒台账',
    '--set-version-string', 'LegalCopyright', '',
    '--set-version-string', 'OriginalFilename', EXE_NAME,
    '--set-file-version', '0.1.0',
    '--set-product-version', '0.1.0',
  ],
  { stdio: 'inherit' },
);

execFileSync(
  process.execPath,
  [
    join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    exePath,
    'NODE_SEA_BLOB',
    join(BUILD, 'sea.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { stdio: 'inherit' },
);
log(`  ${EXE_NAME}：${mb(statSync(exePath).size)}`);

// ───────────────── 5. 迁移 / 原生模块 / 前端 / 预置 ─────────────────
copyPayload({ root: ROOT, out: OUT, log });

// ───────────────────── 6. 配置 ─────────────────────
log('生成 .env…');
writeEnv(OUT);

// ───────────────────── 7. 批处理 ─────────────────────
log('生成启动脚本…');
writeScripts(OUT, {
  nodePreamble: '',
  vbsPreamble: "\n' 不带参数 = 守护进程角色，它会用 --serve 把服务拉起来（见 entry.cjs）\n",
  vbsRun: `q & here & "\\app\\${EXE_NAME}" & q`,
  // 非 SEA 版只能 taskkill /im node.exe，那会误杀店主电脑上别的 Node 程序。
  // 这版有自己的进程名，可以点名杀
  killImage: EXE_NAME,
  initCmd: `"%~dp0app\\${EXE_NAME}" --init-only`,
  iconLocation: `%~dp0app\\${EXE_NAME},0`,
  nodeCheck: false,
  readmeNote: ['这个版本不需要另外安装 Node —— 整个文件夹拷走就能用。'],
});

// ───────────────────── 8. 收尾 ─────────────────────
rmSync(BUILD, { recursive: true, force: true });

const size = dirSize(OUT);
console.log('');
log(`产出：${OUT}`);
log(`大小：${mb(size)}（不需要再另外装 Node）`);
console.log('');
