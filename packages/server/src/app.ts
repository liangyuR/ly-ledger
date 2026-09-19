import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { getDb } from './db';
import { registerRoutes } from './routes';

/**
 * 前端产物由后端一并托管：`/` 出前端，`/api` 走后端。
 * 同域，省掉 CORS，也省掉第二个进程 —— 便携包里只有一个服务要管。
 */
function serveWeb(app: FastifyInstance): void {
  const candidates = [
    process.env.WEB_DIST,
    resolve(__dirname, '..', 'web'),                       // 打包后的布局
    resolve(__dirname, '..', '..', 'web', 'dist'),         // 开发期 workspace 布局
  ].filter(Boolean) as string[];

  const root = candidates.find((p) => existsSync(resolve(p, 'index.html')));
  if (!root) {
    app.log.info('没找到前端产物，只提供 API。开发期前端跑在 vite dev 上');
    return;
  }

  app.register(fastifyStatic, { root, prefix: '/' });

  // SPA 回退：刷新 /sell 这类前端路由时也要给 index.html，
  // 但 /api 下的 404 要老老实实返回 404，不能喂给前端
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/health')) {
      reply.status(404).send({ ok: false, error: `没有这个接口：${req.url}` });
      return;
    }
    reply.sendFile('index.html');
  });

  app.log.info({ root }, '已托管前端产物');
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
  });

  app.get('/health', async () => {
    const db = getDb();
    const { v } = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    const { n } = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get() as { n: number };
    return { ok: true, sqlite: v, tables: n };
  });

  await registerRoutes(app);
  serveWeb(app);

  return app;
}
