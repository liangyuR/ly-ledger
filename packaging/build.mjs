/**
 * Windows 免安装便携包。
 *
 * 产出一个可以整体复制的文件夹 —— 换电脑、重装系统只需要拷这个文件夹。
 * 不上 Docker（太重、要 WSL2、吃内存），也不装系统级 Node。
 *
 * 跑法：npm run package
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(HERE, 'out', '烟酒台账');

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

// 迁移文件。migrate.ts 用 __dirname/migrations 找它们，
// 打包后 __dirname 就是 app/，所以放在 app/migrations
cpSync(join(ROOT, 'packages/server/src/db/migrations'), join(OUT, 'app', 'migrations'), {
  recursive: true,
});

// ───────────────────── 3. 原生模块 ─────────────────────
log('拷贝 better-sqlite3（只带 win32-x64 那个二进制）…');
const sqliteSrc = join(ROOT, 'node_modules/better-sqlite3');
const sqliteOut = join(OUT, 'app', 'node_modules', 'better-sqlite3');
mkdirSync(join(sqliteOut, 'prebuilds'), { recursive: true });
cpSync(join(sqliteSrc, 'lib'), join(sqliteOut, 'lib'), { recursive: true });
cpSync(join(sqliteSrc, 'package.json'), join(sqliteOut, 'package.json'));
cpSync(join(sqliteSrc, 'LICENSE'), join(sqliteOut, 'LICENSE'));
// 8 个平台的预编译二进制只留 Windows 那个，其余是纯浪费
cpSync(join(sqliteSrc, 'prebuilds', 'win32-x64.node'), join(sqliteOut, 'prebuilds', 'win32-x64.node'));

// ───────────────────────── 4. 前端 ─────────────────────────
log('拷贝前端产物…');
const webDist = join(ROOT, 'packages/web/dist');
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('\n前端还没构建。先跑：npm run web:build\n');
  process.exit(1);
}
cpSync(webDist, join(OUT, 'web'), { recursive: true });

// ───────────────────────── 5. 数据与目录 ─────────────────────────
cpSync(join(ROOT, 'seed'), join(OUT, 'seed'), { recursive: true });
mkdirSync(join(OUT, 'data'), { recursive: true });
mkdirSync(join(OUT, 'backup'), { recursive: true });
mkdirSync(join(OUT, 'runtime'), { recursive: true });
mkdirSync(join(OUT, 'tools'), { recursive: true });

// 崩溃守护
cpSync(join(HERE, 'supervise.cjs'), join(OUT, 'supervise.cjs'));
mkdirSync(join(OUT, 'logs'), { recursive: true });

// 恢复说明要跟着包走 —— 出事那天在这个文件夹里就能找到
cpSync(join(ROOT, 'docs/06-备份与恢复.md'), join(OUT, '出事了看这个-备份与恢复.md'));

// ───────────────────────── 6. 配置 ─────────────────────────
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

// ───────────────────────── 7. 批处理 ─────────────────────────
log('生成启动脚本…');

/** 所有 .bat 都要先 cd 到自己所在目录 —— 双击时 cwd 是桌面，不是这里 */
const CD = '@echo off\r\ncd /d "%~dp0"\r\nchcp 65001 >nul\r\n';

/** 优先用包里的便携版 Node，没有就退回系统的 */
const NODE = [
  'set NODE_EXE=runtime\\node\\node.exe',
  'if not exist "%NODE_EXE%" set NODE_EXE=node',
  '',
].join('\r\n');

const files = {
  '启动台账.bat': `${CD}${NODE}
echo 正在启动烟酒台账...
rem 用 vbs 起后台进程：老板不会去分辨哪个黑窗口能关、哪个不能关，
rem 一旦误关，柜台上正在录的那笔单就没了
cscript //nologo 后台启动.vbs
timeout /t 3 /nobreak >nul
start "" msedge.exe --app=http://127.0.0.1:13000
exit
`,

  // 无窗口启动。--app 那个窗口才是老板该看到的唯一一个
  '后台启动.vbs': `Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

nodeExe = here & "\\runtime\\node\\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

sh.CurrentDirectory = here
' 起的是守护进程不是服务本身：服务挂了它会把服务拉起来
' 第二个参数 0 = 隐藏窗口，第三个 False = 不等它结束
' 用 Chr(34) 拼引号，不靠数连续引号 —— 那种写法多一对少一对都不报错，只是启动不了
q = Chr(34)
sh.Run q & nodeExe & q & " " & q & here & "\\supervise.cjs" & q, 0, False
`,

  '停止台账.bat': `${CD}
echo 正在停止...
rem 一起杀掉：只杀服务的话，守护进程会立刻把它拉回来
taskkill /f /im node.exe >nul 2>&1
echo 已停止。数据都在 data\\ledger.db 里，没有丢。
pause
`,

  '安装.bat': `${CD}${NODE}
echo ============================================
echo   烟酒台账 首次安装
echo ============================================
echo.

"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
  echo [x] 找不到 Node。
  echo     把便携版 Node 解压到 runtime\\node\\ 下面，
  echo     确保 runtime\\node\\node.exe 存在，然后重新运行本脚本。
  pause
  exit /b 1
)
echo [1/3] Node 检查通过

echo [2/3] 建桌面快捷方式
set SHORTCUT=%USERPROFILE%\\Desktop\\烟酒台账.lnk
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
  "$s.TargetPath='%~dp0启动台账.bat';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.Description='烟酒台账';" ^
  "$s.Save()"

echo [3/4] 初始化数据库
"%NODE_EXE%" app\\server.cjs --init-only

echo [4/4] 设置开机自启
rem 用 Windows 自带的任务计划，不引入 nssm 这类第三方二进制 ——
rem 便携包里多一个来历不明的 exe，在店主的电脑上是个说不清的东西
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

  '卸载.bat': `${CD}
echo 这会删掉桌面快捷方式，但**不会**删数据。
echo 数据在 data\\ledger.db，备份在 backup\\ 下面。
echo 真要彻底删干净，请手动删除整个文件夹 —— 删之前先把数据拷走。
echo.
pause
del "%USERPROFILE%\\Desktop\\烟酒台账.lnk" >nul 2>&1
schtasks /delete /tn "烟酒台账" /f >nul 2>&1
taskkill /f /im node.exe >nul 2>&1
echo 快捷方式已删除，数据保留在原处。
pause
`,
};

for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(OUT, name), content, 'utf8');
}

// ───────────────────────── 8. 说明 ─────────────────────────
writeFileSync(
  join(OUT, '读我.txt'),
  [
    '烟酒台账',
    '',
    '第一次用：双击「安装.bat」（会顺带设好开机自启）',
    '平时用：  双击桌面上的「烟酒台账」',
    '关掉：    双击「停止台账.bat」',
    '',
    '你的数据全部在 data\\ledger.db 这一个文件里。',
    '把这个文件复制走，等于把账复制走了。',
    '',
    '软件每天凌晨 3 点自动备份到 backup\\ 下面，保留最近 30 天。',
    '但本机备份防不了硬盘损坏 —— 请准备一个 U 盘常插着，',
    '每周在软件首页点一次「备份到 U 盘」。',
    '',
    '软件万一崩了会自己爬起来，重启记录写在 logs\supervisor.log。',
    '如果它反复崩（两分钟内 5 次），会停下来不再重试 —— 那说明不是偶发问题，',
    '请把那个日志发给维护者。数据不会因此丢失。',
    '',
    '出事了怎么办：看「出事了看这个-备份与恢复.md」。',
    '建议现在就打印一份压在柜台下面 —— 电脑开不了机的时候，',
    '你没法在电脑上看它。',
    '',
  ].join('\r\n'),
  'utf8',
);

// ───────────────────────── 9. 收尾 ─────────────────────────
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
log(`大小：${(size / 1048576).toFixed(1)} MB`);
if (nodeMissing) {
  console.log('');
  log('还差便携版 Node —— 见 runtime\\把便携版-Node-解压到这里.txt');
  log('（不放也能跑，前提是目标电脑已装 Node ≥ 20）');
}
console.log('');
