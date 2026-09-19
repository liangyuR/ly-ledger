import './env';

import { buildApp } from './app';
import { migrate } from './db/migrate';
import { scheduleBackups } from './services/backup-schedule';

async function main() {
  // 启动即迁移。单机部署没有独立的运维步骤，
  // 升级覆盖 app 后第一次启动就得把表结构带上来。
  const { applied } = migrate();

  // 安装.bat 用它：只建表然后退出，不启服务
  if (process.argv.includes('--init-only')) {
    console.log(applied.length ? `已建表（${applied.length} 个迁移）` : '表已经是最新的');
    return;
  }

  const app = await buildApp();
  if (applied.length) {
    app.log.info({ applied }, '已执行迁移');
  }

  scheduleBackups(app.log);

  await app.listen({
    port: Number(process.env.APP_PORT) || 13000,
    // 只监听回环地址：柜台电脑，不对局域网暴露。
    host: process.env.APP_HOST || '127.0.0.1',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
