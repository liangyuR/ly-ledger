import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from './index';

const DIR = resolve(__dirname, 'migrations');

export interface MigrateResult {
  applied: string[];
  skipped: number;
}

/**
 * 按文件名顺序执行 migrations/*.sql，已执行过的跳过。
 * 每个迁移整体在一个事务里 —— 失败就整体回滚，不留半个表。
 *
 * 幂等：反复执行结果一致。发版前必须在**有真实数据的库**上试跑过，
 * 空库迁移成功不说明任何问题（docs/03 迁移纪律）。
 */
export function migrate(): MigrateResult {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const done = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );

  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(resolve(DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    })();
    applied.push(file);
  }

  return { applied, skipped: done.size };
}
