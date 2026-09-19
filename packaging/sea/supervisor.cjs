/**
 * 崩溃守护 —— SEA 版。
 *
 * 逻辑和 packaging/supervise.cjs 完全一致（退避、稳定判定、崩溃上限都没改），
 * 只有两处不同：
 *
 *   1. ROOT 从 __dirname 变成 __dirname/..  ——  SEA 里 __dirname 是 exe 所在
 *      目录，也就是 app/，而 logs/ 在包根上。
 *   2. 拉起服务从 spawn(node, [server.cjs]) 变成 spawn(自己, ['--serve'])。
 *
 * 不引第三方进程管理器的理由没变：便携包里多一个来历不明的 exe，
 * 在店主的电脑上是个说不清的东西。
 */
'use strict';

const { spawn } = require('node:child_process');
const { appendFileSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

// SEA 里 __dirname = exe 所在目录 = <包根>/app，包根要再上一层
const ROOT = resolve(__dirname, '..');
const LOG_DIR = join(ROOT, 'logs');
const LOG = join(LOG_DIR, 'supervisor.log');

/** 稳定跑够这么久，就认为上次重启成功了，退避重新计时 */
const STABLE_MS = 60_000;
/** 退避：1s 起，翻倍，封顶 30s */
const BACKOFF_MIN = 1_000;
const BACKOFF_MAX = 30_000;
/** 短时间内崩这么多次就不再重启 —— 否则会无限打转，日志涨到撑爆磁盘 */
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 120_000;

mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    appendFileSync(LOG, line);
  } catch {
    /* 日志写不进去也不能因此不干活 */
  }
  process.stdout.write(line);
}

let backoff = BACKOFF_MIN;
let crashTimes = [];
let child = null;
let stopping = false;

function start() {
  const startedAt = Date.now();

  // 拉起的是 exe 自己，多带一个 --serve 走服务分支（见 entry.cjs）
  child = spawn(process.execPath, ['--serve'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;

    const ranMs = Date.now() - startedAt;

    // 正常退出（比如我们自己停的）就不要再拉起来
    if (code === 0) {
      log(`服务正常退出，守护进程一并结束`);
      process.exit(0);
    }

    log(`服务异常退出（code=${code} signal=${signal}），已运行 ${Math.round(ranMs / 1000)} 秒`);

    // 跑够久说明上次是稳的，这次是新问题，退避重新计时
    if (ranMs >= STABLE_MS) {
      backoff = BACKOFF_MIN;
      crashTimes = [];
    }

    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    crashTimes.push(now);

    if (crashTimes.length >= CRASH_LIMIT) {
      log(
        `${Math.round(CRASH_WINDOW_MS / 1000)} 秒内崩了 ${crashTimes.length} 次，不再自动重启。\n` +
          `  这已经不是偶发问题了，反复拉起只会把日志写满。\n` +
          `  数据没有丢，都在 data\\ledger.db 里。请把 logs\\supervisor.log 发给维护者。`,
      );
      process.exit(1);
    }

    log(`${backoff / 1000} 秒后重启（第 ${crashTimes.length} 次）`);
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  });

  child.on('error', (err) => {
    log(`拉起服务失败：${err.message}`);
  });
}

function stop() {
  stopping = true;
  if (child) child.kill();
  log('守护进程收到停止信号');
  process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

log('守护进程启动');
start();
