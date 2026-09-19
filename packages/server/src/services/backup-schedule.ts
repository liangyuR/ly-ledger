import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';

import { backupStatus, runBackup } from './backup';

/**
 * 每天凌晨 3 点自动备份。
 *
 * 启动时也补一次：柜台电脑不是 7×24 开机的，凌晨三点多半关着。
 * 只在今天还没备份过时才补，不会每次重启都写一份。
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

  cron.schedule('0 3 * * *', () => void runAndLog('定时'), { timezone: 'Asia/Shanghai' });

  const status = backupStatus();
  const today = new Date().toLocaleDateString('sv-SE');
  if (status.lastBackupFile !== `${today}.db`) {
    void runAndLog('启动补备');
  }

  log.info({ dir: status.dir, count: status.count }, '自动备份已排期：每天 03:00');
}
