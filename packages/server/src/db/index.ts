import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

let handle: Database.Database | null = null;

/** 整个进程共用一个连接。单机单人，不需要连接池。 */
export function getDb(): Database.Database {
  if (handle) return handle;

  const file = process.env.DB_FILE || 'data/ledger.db';
  const path = isAbsolute(file) ? file : resolve(process.cwd(), file);
  mkdirSync(dirname(path), { recursive: true });

  handle = new Database(path);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  // 这是台账不是缓存：断电安全性优先于写入速度。
  // 单人一天几十笔，FULL 带来的开销完全无感。
  handle.pragma('synchronous = FULL');

  return handle;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}
