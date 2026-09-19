import type { FastifyBaseLogger } from 'fastify';

import { backupStatus, runBackup } from './backup';

const BACKUP_HOUR = 3;

/** 距离下一个 hour:00 还有多少毫秒 */
function msUntilNext(hour: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * 每天在 hour:00 跑一次。
 *
 * 自己写而不是用 node-cron：我们只要一个每日任务，而 node-cron 在模块加载时
 * 就用 import.meta.url 算它的 daemon 路径 —— 打进 CJS bundle 后那个值是
 * undefined，整个包起不来。二十行代码换掉一个依赖，顺带少一类打包坑。
 *
 * 电脑睡眠错过了触发点也没关系：醒来后定时器会晚一点触发，
 * 关机错过的则由启动补备兜住。
 */
function scheduleDaily(hour: number, task: () => void): void {
  const arm = () => {
    const timer = setTimeout(() => {
      task();
      arm();
    }, msUntilNext(hour));
    // 不要因为这个定时器挡住进程退出
    timer.unref?.();
  };
  arm();
}

/**
 * 排期每日备份。
 *
 * 启动时也补一次：柜台电脑不是 7×24 开机的，凌晨三点多半关着。
 * 只在今天还没备过时才补，不会每次重启都写一份。
 */
export function scheduleBackups(log: FastifyBaseLogger): void {
  if (process.env.BACKUP_DISABLED === '1') {
    log.warn('自动备份已被 BACKUP_DISABLED 关闭');
    return;
  }

  const runAndLog = async (reason: string) => {
    const r = await runBackup();
    if (r.ok) {
      log.info({ file: r.file, sizeBytes: r.sizeBytes, reason }, '备份完成');
    } else {
      // 静默失败的备份等于没有备份
      log.error({ error: r.error, reason }, '备份失败');
    }
  };

  scheduleDaily(BACKUP_HOUR, () => void runAndLog('定时'));

  const status = backupStatus();
  const todayFile = `${new Date().toLocaleDateString('sv-SE')}.db`;
  if (status.lastBackupFile !== todayFile) {
    void runAndLog('启动补备');
  }

  log.info(
    { dir: status.dir, count: status.count },
    `自动备份已排期：每天 ${String(BACKUP_HOUR).padStart(2, '0')}:00`,
  );
}
