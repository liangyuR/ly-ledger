import './env';

import { Application, Gateway } from '@nocobase/server';
import config from './config';

const app = new Application(config);

if (require.main === module) {
  const command = process.argv[2];

  if (command === 'start') {
    /**
     * Application.start() 只做加载和启动，**不绑端口** ——
     * HTTP 监听在 Gateway 手里，平时由 NocoBase 自己的 CLI 拉起来。
     * 本项目直连 Application、绕开了那个 CLI，所以必须自己 run 一遍，
     * 否则进程活着、日志也打印 "app has been started"，但没有任何人监听端口。
     */
    app.runAsCLI().then(() => {
      Gateway.getInstance().start({
        port: Number(process.env.APP_PORT) || 13000,
        // 只监听回环地址。服务跑在柜台电脑上，不对局域网暴露（见 docs/03 认证一节）。
        host: process.env.APP_HOST || '127.0.0.1',
      });
    });
  } else {
    app.runAsCLI();
  }
}

export default app;
