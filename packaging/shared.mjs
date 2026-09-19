/**
 * 两套打包脚本的公共部分。
 *
 * build.mjs（外挂便携版 Node）和 sea.mjs（单 exe）只在"怎么把服务拉起来"
 * 这一点上不同，其余的 —— 拷哪些文件、.env 怎么写、五个 .bat 说什么 ——
 * 完全一样。这些东西写给店主看，措辞得改就得两处一起改，分成两份迟早对不上。
 *
 * 所以差异收敛成一个 variant 对象（见 writeScripts 的注释），别的都在这里。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** 所有 .bat 都要先 cd 到自己所在目录 —— 双击时 cwd 是桌面，不是这里 */
export const CD = '@echo off\r\ncd /d "%~dp0"\r\nchcp 65001 >nul\r\n';

export const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

export function dirSize(dir) {
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

/**
 * 迁移文件、原生模块、前端产物、预置数据，以及几个空目录。
 *
 * app/ 下的布局两个版本是一样的：非 SEA 是 server.cjs，SEA 是 exe，
 * 但它们的 __dirname 都落在 app/ 上，所以 migrations 和 node_modules
 * 的位置可以完全一致。
 */
export function copyPayload({ root, out, log }) {
  cpSync(join(root, 'packages/server/src/db/migrations'), join(out, 'app', 'migrations'), {
    recursive: true,
  });

  log('拷贝 better-sqlite3（只带 win32-x64 那个二进制）…');
  const src = join(root, 'node_modules/better-sqlite3');
  const dst = join(out, 'app', 'node_modules', 'better-sqlite3');
  mkdirSync(join(dst, 'prebuilds'), { recursive: true });
  cpSync(join(src, 'lib'), join(dst, 'lib'), { recursive: true });
  cpSync(join(src, 'package.json'), join(dst, 'package.json'));
  cpSync(join(src, 'LICENSE'), join(dst, 'LICENSE'));
  // 8 个平台的预编译二进制只留 Windows 那个，其余是纯浪费
  cpSync(join(src, 'prebuilds', 'win32-x64.node'), join(dst, 'prebuilds', 'win32-x64.node'));

  log('拷贝前端产物…');
  const webDist = join(root, 'packages/web/dist');
  if (!existsSync(join(webDist, 'index.html'))) {
    console.error('\n前端还没构建。先跑：npm run web:build\n');
    process.exit(1);
  }
  cpSync(webDist, join(out, 'web'), { recursive: true });

  cpSync(join(root, 'seed'), join(out, 'seed'), { recursive: true });
  for (const d of ['data', 'backup', 'logs', 'tools']) {
    mkdirSync(join(out, d), { recursive: true });
  }

  // 恢复说明要跟着包走 —— 出事那天在这个文件夹里就能找到
  cpSync(join(root, 'docs/06-备份与恢复.md'), join(out, '出事了看这个-备份与恢复.md'));

  // 桌面快捷方式要拿它当图标。SEA 版的 exe 里虽然已经嵌了一份，但这个文件
  // 两个版本都要有 —— 非 SEA 版没有自己的 exe 可指
  cpSync(join(root, 'packaging/icon/烟酒台账.ico'), join(out, 'app', '烟酒台账.ico'));
}

export function writeEnv(out) {
  writeFileSync(
    join(out, '.env'),
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
}

/**
 * 五个 .bat / .vbs 和读我.txt。
 *
 * variant 就是两个版本的全部差异：
 *   nodePreamble    启动台账.bat 开头要不要找 Node
 *   vbsRun          后台启动.vbs 里真正拉起来的那条命令（VBScript 表达式）
 *   vbsPreamble     拼这条命令之前要先算的东西
 *   killImage       停止台账.bat 要杀的进程名
 *   initCmd         安装.bat 里初始化数据库的命令
 *   iconLocation    快捷方式的图标（空串 = 不设，用 .bat 的默认齿轮图标）
 *   nodeCheck       安装.bat 要不要先验一遍 Node（外挂 Node 的版本才需要）
 *   readmeNote      读我.txt 末尾补充的话
 */
export function writeScripts(out, v) {
  // 步骤编号算出来，不手写 —— 手写的那版曾经是 [1/3][2/3][3/4][4/4]
  const steps = [];
  if (v.nodeCheck) {
    steps.push({
      title: 'Node 检查通过',
      before: `"%NODE_EXE%" --version >nul 2>&1
if errorlevel 1 (
  echo [x] 找不到 Node。
  echo     把便携版 Node 解压到 runtime\\node\\ 下面，
  echo     确保 runtime\\node\\node.exe 存在，然后重新运行本脚本。
  pause
  exit /b 1
)`,
      body: '',
    });
  }
  steps.push({
    title: '建桌面快捷方式',
    before: '',
    body: `set SHORTCUT=%USERPROFILE%\\Desktop\\烟酒台账.lnk
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
  "$s.TargetPath='%~dp0启动台账.bat';" ^
  "$s.WorkingDirectory='%~dp0';" ^${v.iconLocation ? `\r\n  "$s.IconLocation='${v.iconLocation}';" ^` : ''}
  "$s.Description='烟酒台账';" ^
  "$s.Save()"`,
  });
  steps.push({ title: '初始化数据库', before: '', body: v.initCmd });
  steps.push({
    title: '设置开机自启',
    before: '',
    body: `rem 用 Windows 自带的任务计划，不引入 nssm 这类第三方二进制 ——
rem 便携包里多一个来历不明的 exe，在店主的电脑上是个说不清的东西
schtasks /create /tn "烟酒台账" /tr "wscript.exe \\"%~dp0后台启动.vbs\\"" /sc onlogon /f >nul 2>&1
if errorlevel 1 (
  echo     [!] 开机自启没设上（可能需要管理员权限）。
  echo         不影响使用，每次双击桌面图标就行。
) else (
  echo     开机后会自动在后台跑起来
)`,
  });

  const installSteps = steps
    .map((s, i) => {
      const head = `echo [${i + 1}/${steps.length}] ${s.title}`;
      return [s.before, head, s.body].filter(Boolean).join('\r\n');
    })
    .join('\r\n\r\n');

  const files = {
    '启动台账.bat': `${CD}${v.nodePreamble}
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
${v.vbsPreamble}
sh.CurrentDirectory = here
' 起的是守护进程不是服务本身：服务挂了它会把服务拉起来
' 第二个参数 0 = 隐藏窗口，第三个 False = 不等它结束
' 用 Chr(34) 拼引号，不靠数连续引号 —— 那种写法多一对少一对都不报错，只是启动不了
q = Chr(34)
sh.Run ${v.vbsRun}, 0, False
`,

    '停止台账.bat': `${CD}
echo 正在停止...
rem 一起杀掉：只杀服务的话，守护进程会立刻把它拉回来
taskkill /f /im "${v.killImage}" >nul 2>&1
echo 已停止。数据都在 data\\ledger.db 里，没有丢。
pause
`,

    '安装.bat': `${CD}${v.nodePreamble}
echo ============================================
echo   烟酒台账 首次安装
echo ============================================
echo.

${installSteps}
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
taskkill /f /im "${v.killImage}" >nul 2>&1
echo 快捷方式已删除，数据保留在原处。
pause
`,
  };

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(out, name), content, 'utf8');
  }

  writeFileSync(
    join(out, '读我.txt'),
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
      '软件万一崩了会自己爬起来，重启记录写在 logs\\supervisor.log。',
      '如果它反复崩（两分钟内 5 次），会停下来不再重试 —— 那说明不是偶发问题，',
      '请把那个日志发给维护者。数据不会因此丢失。',
      '',
      '出事了怎么办：看「出事了看这个-备份与恢复.md」。',
      '建议现在就打印一份压在柜台下面 —— 电脑开不了机的时候，',
      '你没法在电脑上看它。',
      ...(v.readmeNote ? ['', ...v.readmeNote] : []),
      '',
    ].join('\r\n'),
    'utf8',
  );
}
