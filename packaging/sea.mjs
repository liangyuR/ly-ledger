/**
 * Windows 免安装便携包 —— SEA 版（试验）。
 *
 * 和 build.mjs 的区别只有一个：不再往包里塞一个 runtime/node/ 目录，
 * 而是把 Node 运行时和后端 bundle 焊成一个 exe（Node 的 single executable
 * application）。店主那边少一个"请自己去 nodejs.org 下载解压"的步骤。
 *
 * 关键发现：SEA 里 __dirname = exe 所在目录，与 cwd 无关。所以只要把 exe
 * 放在 app/ 下（就是原来 server.cjs 的位置），env.ts 的 APP_ROOT、migrate.ts
 * 的 migrations 路径、app.ts 的 web 路径**全部零改动**继续成立。
 *
 * 跑法：npm run web:build && node packaging/sea.mjs
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(HERE, 'out-sea', '烟酒台账');
const BUILD = join(HERE, 'out-sea', '.build');
const EXE_NAME = '烟酒台账.exe';

const log = (msg) => console.log(`  ${msg}`);

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

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

// ───────────────────── 4. 注入进 node.exe ─────────────────────
log('注入可执行文件…');
const exePath = join(OUT, 'app', EXE_NAME);
cpSync(process.execPath, exePath);

// node.exe 是微软签过名的，往后面追加数据会让签名校验失败。
// 先把签名摘掉，Windows 就当它是个普通未签名程序 —— 比留一个"坏签名"干净：
// 坏签名在某些安全软件眼里比没签名更可疑。
const signtool = findSigntool();
if (signtool) {
  execFileSync(signtool, ['remove', '/s', exePath], { stdio: 'ignore' });
  log('  已摘除 node.exe 原有签名');
} else {
  log('  [!] 没找到 signtool，exe 会带一个坏签名（能跑，但不干净）');
}

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

// ───────────────────── 5. 留在磁盘上的东西 ─────────────────────
// 迁移文件。migrate.ts 用 __dirname/migrations 找它们，
// SEA 里 __dirname 就是 app/，所以位置和非 SEA 包完全一样
cpSync(join(ROOT, 'packages/server/src/db/migrations'), join(OUT, 'app', 'migrations'), {
  recursive: true,
});

log('拷贝 better-sqlite3（只带 win32-x64 那个二进制）…');
const sqliteSrc = join(ROOT, 'node_modules/better-sqlite3');
const sqliteOut = join(OUT, 'app', 'node_modules', 'better-sqlite3');
mkdirSync(join(sqliteOut, 'prebuilds'), { recursive: true });
cpSync(join(sqliteSrc, 'lib'), join(sqliteOut, 'lib'), { recursive: true });
cpSync(join(sqliteSrc, 'package.json'), join(sqliteOut, 'package.json'));
cpSync(join(sqliteSrc, 'LICENSE'), join(sqliteOut, 'LICENSE'));
cpSync(join(sqliteSrc, 'prebuilds', 'win32-x64.node'), join(sqliteOut, 'prebuilds', 'win32-x64.node'));

log('拷贝前端产物…');
const webDist = join(ROOT, 'packages/web/dist');
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('\n前端还没构建。先跑：npm run web:build\n');
  process.exit(1);
}
cpSync(webDist, join(OUT, 'web'), { recursive: true });

// ───────────────────── 6. 数据与目录 ─────────────────────
cpSync(join(ROOT, 'seed'), join(OUT, 'seed'), { recursive: true });
mkdirSync(join(OUT, 'data'), { recursive: true });
mkdirSync(join(OUT, 'backup'), { recursive: true });
mkdirSync(join(OUT, 'logs'), { recursive: true });
mkdirSync(join(OUT, 'tools'), { recursive: true });
cpSync(join(ROOT, 'docs/06-备份与恢复.md'), join(OUT, '出事了看这个-备份与恢复.md'));

// ───────────────────── 7. 配置 ─────────────────────
log('生成 .env…');
writeFileSync(
  join(OUT, '.env'),
  [
    'APP_PORT=13000',
    '# 只监听回环地址，不对局域网暴露',
    'APP_HOST=127.0.0.1',
    '',
    '# 全部数据就这一个文件。备份 = 复制它',
    'DB_FILE=data/ledger.db',
    'BACKUP_DIR=backup',
    '',
    'SEED_FILE=seed/products.sample.json',
    'WEB_DIST=web',
    '',
    'LOG_LEVEL=info',
    `# 打包于 ${new Date().toISOString()}`,
    `APP_BUILD=${randomBytes(4).toString('hex')}`,
    '',
  ].join('\r\n'),
  'utf8',
);

// ───────────────────── 8. 批处理 ─────────────────────
log('生成启动脚本…');

/** 所有 .bat 都要先 cd 到自己所在目录 —— 双击时 cwd 是桌面，不是这里 */
const CD = '@echo off\r\ncd /d "%~dp0"\r\nchcp 65001 >nul\r\n';

const files = {
  '启动台账.bat': `${CD}
echo 正在启动烟酒台账...
rem 用 vbs 起后台进程：老板不会去分辨哪个黑窗口能关、哪个不能关，
rem 一旦误关，柜台上正在录的那笔单就没了
cscript //nologo 后台启动.vbs
timeout /t 3 /nobreak >nul
start "" msedge.exe --app=http://127.0.0.1:13000
exit
`,

  '后台启动.vbs': `Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

sh.CurrentDirectory = here
' 不带参数 = 守护进程角色，它会用 --serve 把服务拉起来（见 entry.cjs）
' 第二个参数 0 = 隐藏窗口，第三个 False = 不等它结束
q = Chr(34)
sh.Run q & here & "\\app\\${EXE_NAME}" & q, 0, False
`,

  '停止台账.bat': `${CD}
echo 正在停止...
rem SEA 版这里可以精确点名自己的进程。
rem 非 SEA 版只能 taskkill /im node.exe —— 那会误杀店主电脑上别的 Node 程序
taskkill /f /im "${EXE_NAME}" >nul 2>&1
echo 已停止。数据都在 data\\ledger.db 里，没有丢。
pause
`,

  '安装.bat': `${CD}
echo ============================================
echo   烟酒台账 首次安装
echo ============================================
echo.

echo [1/3] 建桌面快捷方式
set SHORTCUT=%USERPROFILE%\\Desktop\\烟酒台账.lnk
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
  "$s.TargetPath='%~dp0启动台账.bat';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.IconLocation='%~dp0app\\${EXE_NAME},0';" ^
  "$s.Description='烟酒台账';" ^
  "$s.Save()"

echo [2/3] 初始化数据库
"%~dp0app\\${EXE_NAME}" --init-only

echo [3/3] 设置开机自启
schtasks /create /tn "烟酒台账" /tr "wscript.exe \\"%~dp0后台启动.vbs\\"" /sc onlogon /f >nul 2>&1
if errorlevel 1 (
  echo     [!] 开机自启没设上（可能需要管理员权限）。
  echo         不影响使用，每次双击桌面图标就行。
) else (
  echo     开机后会自动在后台跑起来
)
echo.
echo 装好了。双击桌面上的「烟酒台账」就能用。
echo.
echo 提醒：准备一个 U 盘常插着，每周在软件里点一次「备份到 U 盘」。
echo       硬盘坏了，本机备份和原始数据是一起没的。
pause
`,
};

for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(OUT, name), content, 'utf8');
}

// ───────────────────── 9. 收尾 ─────────────────────
rmSync(BUILD, { recursive: true, force: true });

const size = dirSize(OUT);
console.log('');
log(`产出：${OUT}`);
log(`大小：${mb(size)}（不需要再另外装 Node）`);
console.log('');
