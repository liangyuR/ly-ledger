import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { APP_ROOT } from '../env';

let handle: Database.Database | null = null;

/** 打开一个连接并设好 pragma。测试用 ':memory:' 拿独立的库。 */
export function openDb(file: string): Database.Database {
  if (file !== ':memory:') {
    const path = isAbsolute(file) ? file : resolve(APP_ROOT, file);
    mkdirSync(dirname(path), { recursive: true });
    file = path;
  }

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  // SQLite 默认不开外键约束 —— 不开的话建表时写的 REFERENCES 形同虚设
  db.pragma('foreign_keys = ON');
  // 这是台账不是缓存：断电安全性优先于写入速度。
  // 单人一天几十笔，FULL 带来的开销完全无感。
  db.pragma('synchronous = FULL');

  return db;
}

/** 整个进程共用一个连接。单机单人，不需要连接池。 */
export function getDb(): Database.Database {
  if (!handle) {
    handle = openDb(process.env.DB_FILE || 'data/ledger.db');
  }
  return handle;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}
