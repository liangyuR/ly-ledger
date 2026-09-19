/** 设置表读写。值一律存字符串，取的时候自己转。 */
import type { Database } from 'better-sqlite3';

export function getSetting(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

export function getFlag(db: Database, key: string): boolean {
  return getSetting(db, key) === '1';
}

export function setFlag(db: Database, key: string, on: boolean): void {
  setSetting(db, key, on ? '1' : '0');
}
