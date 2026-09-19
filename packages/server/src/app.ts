import Fastify, { type FastifyInstance } from 'fastify';

import { getDb } from './db';
import { registerRoutes } from './routes';

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

  return app;
}
