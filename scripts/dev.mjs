/**
 * 开发期一条命令拉起前后端：npm run dev
 *
 * 为什么需要两个进程：上线时只有一个 —— 后端把 packages/web/dist 托在 `/` 上
 * （app.ts）。但开发期要 Vite 的热更新，它得自己起一个 5173，把 /api 转给 13000
 * （vite.config.ts 的 proxy）。所以开发期两个、上线一个。
 *
 * 为什么不用 concurrently：这活就这么点，不值一个依赖。同一个理由，
 * node-cron 也换成了二十行自己写的（backup-schedule.ts）。
 *
 * 一个死了就把另一个也带走。半死不活最坑人 —— 后端崩了，Vite 还在，
 * 页面照样打得开，只是每个请求都失败，人会以为是自己代码写错了。
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const WIN = process.platform === 'win32';

const JOBS = [
  { name: '后端', color: '[36m', cmd: 'npm run dev -w @ly-ledger/server' },
  { name: '前端', color: '[35m', cmd: 'npm run dev -w @ly-ledger/web' },
];

const DIM = '[2m';
const OFF = '[0m';

const children = [];
let stopping = false;

/**
 * Windows 上 spawn 出来的是 cmd.exe，npm 和真正的进程都是它的子孙，
 * 光 kill 这一个只会留下一堆孤儿占着 13000 和 5173。得整棵树一起杀。
 */
function killTree(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (WIN) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) killTree(c);
  // 给 taskkill 一点时间，否则端口还占着就退出了，下一次启动会撞 EADDRINUSE
  setTimeout(() => process.exit(code), 300);
}

for (const job of JOBS) {
  const child = spawn(job.cmd, {
    cwd: ROOT,
    // .cmd 在新版 Node 上必须走 shell，直接 spawn 会被拒
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  const prefix = `${job.color}${job.name}${OFF} ${DIM}│${OFF} `;
  const pipe = (stream) => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code, signal) => {
    if (stopping) return;
    process.stdout.write(`${prefix}退出了（code=${code} signal=${signal}），另一个也一起停掉\n`);
    stopAll(code ?? 1);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => stopAll(0));
}

process.stdout.write(
  `\n  ${DIM}前后端都起来了。打开${OFF} http://localhost:5173 ${DIM}—— 改代码会自动刷新${OFF}\n` +
    `  ${DIM}Ctrl-C 一次把两个都停掉${OFF}\n\n`,
);
