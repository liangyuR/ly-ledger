import assert from 'node:assert/strict';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { openDb } from '../db';
import { migrate } from '../db/migrate';
import { backupStatus, listBackups, runBackup, verifyBackup } from './backup';

let db: Database;
let dir: string;
let dbFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ly-backup-'));
  process.env.BACKUP_DIR = join(dir, 'backup');

  // 备份 API 要求源库落在磁盘上，内存库备不出东西
  dbFile = join(dir, 'ledger.db');
  db = openDb(dbFile);
  migrate(db);
  db.prepare(`INSERT INTO customers (name) VALUES ('老王')`).run();
});

afterEach(() => {
  db.close();
  delete process.env.BACKUP_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('备份', () => {
  it('能备出一个可用的文件', async () => {
    const r = await runBackup(db);
    assert.equal(r.ok, true, r.error);
    assert.match(r.file!, /^\d{4}-\d{2}-\d{2}\.db$/);
    assert.ok((r.sizeBytes ?? 0) > 0);

    const files = listBackups();
    assert.equal(files.length, 1);
    assert.equal(verifyBackup(files[0].path).ok, true);
  });

  it('备份里的数据是真的', async () => {
    await runBackup(db);
    const copy = openDb(listBackups()[0].path);
    const row = copy.prepare('SELECT name FROM customers').get() as { name: string };
    copy.close();
    assert.equal(row.name, '老王');
  });

  it('不留 .tmp 中间文件', async () => {
    await runBackup(db);
    const leftovers = readdirSync(process.env.BACKUP_DIR!).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('同一天重复备份不会堆积', async () => {
    await runBackup(db);
    await runBackup(db);
    assert.equal(listBackups().length, 1);
  });
});

describe('备份校验', () => {
  // 只验证"写出了文件"是不够的 —— 损坏的备份比没有备份更危险，
  // 它让老板以为自己有后路
  it('认得出损坏的文件', () => {
    const bad = join(dir, 'broken.db');
    writeFileSync(bad, 'this is definitely not a sqlite database');
    const r = verifyBackup(bad);
    assert.equal(r.ok, false);
  });

  it('认得出"完整但不是台账库"的文件', () => {
    const empty = join(dir, 'empty.db');
    const e = openDb(empty);
    e.exec('CREATE TABLE whatever (a INTEGER)');
    e.close();

    const r = verifyBackup(empty);
    assert.equal(r.ok, false, '一个空但结构完整的库同样没用');
    assert.match(r.detail, /sales/);
  });

  it('文件不存在也不炸', () => {
    assert.equal(verifyBackup(join(dir, '不存在.db')).ok, false);
  });
});

describe('备份状态', () => {
  it('从来没备份过要算过期', () => {
    const s = backupStatus();
    assert.equal(s.count, 0);
    assert.equal(s.lastBackupAt, null);
    assert.equal(s.stale, true, '没有备份就是最危险的状态，必须标红');
  });

  it('刚备份完不过期', async () => {
    await runBackup(db);
    const s = backupStatus();
    assert.equal(s.count, 1);
    assert.equal(s.ageDays, 0);
    assert.equal(s.stale, false);
  });
});

describe('滚动保留', () => {
  it('只留最近 30 份', async () => {
    const backupPath = process.env.BACKUP_DIR!;
    await runBackup(db); // 先建出目录

    // 造 40 份历史备份（内容无所谓，prune 只看文件名排序）
    for (let i = 1; i <= 40; i += 1) {
      const day = `2026-08-${String(i).padStart(2, '0')}`;
      if (i <= 31) writeFileSync(join(backupPath, `${day}.db`), 'x');
    }
    assert.ok(listBackups().length > 30);

    await runBackup(db);
    assert.equal(listBackups().length, 30, '超出的旧备份要滚掉，否则磁盘迟早被占满');
    assert.ok(existsSync(join(backupPath, `${new Date().toLocaleDateString('sv-SE')}.db`)), '今天的必须在');
  });
});

describe('备份是单文件', () => {
  it('不留 -shm / -wal 边车文件', async () => {
    await runBackup(db);
    const junk = readdirSync(process.env.BACKUP_DIR!).filter(
      (f) => f.endsWith('-shm') || f.endsWith('-wal') || f.endsWith('.tmp'),
    );
    assert.deepEqual(junk, [], '备份目录里只该有 .db —— 恢复说明写的是"复制这一个文件"');
  });

  it('备份文件本身不是 WAL 模式', async () => {
    await runBackup(db);
    // 必须只读打开：openDb() 会在打开时把库设成 WAL，那就测不出原本的模式了
    const copy = new BetterSqlite3(listBackups()[0].path, { readonly: true });
    const mode = copy.pragma('journal_mode', { simple: true });
    copy.close();
    assert.notEqual(String(mode).toLowerCase(), 'wal', 'WAL 库离开边车文件就不完整了');
  });
});
