/**
 * 备份与恢复。
 *
 * **本地部署的头号风险不是技术问题，是数据丢失。** 跑在云上硬盘坏了还有
 * 服务商快照；跑在柜台电脑上，硬盘坏了就是几年台账全没，而老板绝不会
 * 自己备份。所以备份不是运维事项，是一期必须交付的产品功能，
 * 优先级高于利润报表（docs/03）。
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { getDb } from '../db';
import { APP_ROOT } from '../env';

const KEEP = 30;

export function backupDir(): string {
  const dir = process.env.BACKUP_DIR || 'backup';
  const path = isAbsolute(dir) ? dir : resolve(APP_ROOT, dir);
  mkdirSync(path, { recursive: true });
  return path;
}

export interface BackupFile {
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export function listBackups(): BackupFile[] {
  const dir = backupDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const p = join(dir, f);
      const st = statSync(p);
      return { name: f, path: p, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/**
 * 校验备份文件本身是否可用。
 *
 * **只验证"写出了文件"是不够的。** 一个损坏的备份比没有备份更危险 ——
 * 它让老板以为自己有后路，真到要恢复那天才发现没有。
 * 校验一个几十 MB 的 SQLite 文件是毫秒级的事，没有理由省。
 */
/** 删掉 SQLite 打开 WAL 库时生成的 -shm / -wal 边车文件 */
function dropSidecars(path: string): void {
  for (const suffix of ['-shm', '-wal']) {
    try {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    } catch {
      /* 删不掉不影响备份本身 */
    }
  }
}

/**
 * 把备份文件转成单文件模式（journal_mode = DELETE）。
 *
 * 源库跑在 WAL 下，备份出来也是 WAL —— 那就不是"一个文件"了。
 * 而恢复说明写的是"把这一个 .db 复制回去"，老板不会也不该去管边车文件。
 * 转成 DELETE 模式让这句承诺是字面成立的。
 */
function makeSingleFile(path: string): void {
  const db = new Database(path);
  try {
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  dropSidecars(path);
}

export function verifyBackup(path: string): { ok: boolean; detail: string } {
  let probe: Database.Database | null = null;
  try {
    probe = new Database(path, { readonly: true, fileMustExist: true });
    const row = probe.pragma('integrity_check', { simple: true }) as string;
    if (row !== 'ok') return { ok: false, detail: `integrity_check: ${row}` };

    // 再确认业务表真的在里面 —— 一个空但"完整"的库同样没用
    const n = probe
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='sales'")
      .get() as { n: number };
    if (n.n !== 1) return { ok: false, detail: '备份里没有 sales 表，不是一个有效的台账库' };

    return { ok: true, detail: 'ok' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  } finally {
    probe?.close();
    // 只读打开也会生成边车文件，别把垃圾留在备份目录
    dropSidecars(path);
  }
}

export interface BackupResult {
  ok: boolean;
  file?: string;
  sizeBytes?: number;
  error?: string;
}

/**
 * 做一次备份。
 *
 * 用 SQLite 的在线 backup API，**不是直接复制文件** ——
 * 直接 copy 正在写入的 db 会得到损坏的副本。
 *
 * 校验不通过就删掉这个坏文件，**保留上一份不覆盖**。
 */
export async function runBackup(source?: Database.Database): Promise<BackupResult> {
  const dir = backupDir();
  const day = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
  const target = join(dir, `${day}.db`);
  const temp = `${target}.tmp`;

  try {
    await (source ?? getDb()).backup(temp);
    makeSingleFile(temp);

    const check = verifyBackup(temp);
    if (!check.ok) {
      try {
        unlinkSync(temp);
        dropSidecars(temp);
      } catch {
        /* 删不掉就算了，反正它不会被当成有效备份 */
      }
      return { ok: false, error: `备份文件校验没通过：${check.detail}。上一份备份保持不动` };
    }

    if (existsSync(target)) unlinkSync(target);
    copyFileSync(temp, target);
    unlinkSync(temp);

    prune();
    return { ok: true, file: basename(target), sizeBytes: statSync(target).size };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 滚动保留最近 30 份 */
function prune(): void {
  const files = listBackups();
  for (const f of files.slice(KEEP)) {
    try {
      unlinkSync(f.path);
    } catch {
      /* 删不掉不影响备份本身 */
    }
  }
}

export interface BackupStatus {
  lastBackupAt: string | null;
  lastBackupFile: string | null;
  ageDays: number | null;
  /** 超过 3 天没成功备份就该标红 —— 静默失败的备份等于没有备份 */
  stale: boolean;
  count: number;
  dir: string;
}

export function backupStatus(): BackupStatus {
  const files = listBackups();
  const latest = files[0];
  if (!latest) {
    return { lastBackupAt: null, lastBackupFile: null, ageDays: null, stale: true, count: 0, dir: backupDir() };
  }

  const ageDays = Math.floor((Date.now() - new Date(latest.createdAt).getTime()) / 86_400_000);
  return {
    lastBackupAt: latest.createdAt,
    lastBackupFile: latest.name,
    ageDays,
    stale: ageDays > 3,
    count: files.length,
    dir: backupDir(),
  };
}

/**
 * 找可移动盘（U 盘）。
 *
 * 本机备份防不了硬盘损坏 —— 硬盘坏了，备份和原件一起没。
 * 异地副本是这套备份方案里唯一真正兜底的一环。
 */
export function removableDrives(): { letter: string; free: boolean }[] {
  if (process.platform !== 'win32') return [];
  const found: { letter: string; free: boolean }[] = [];
  // C 盘是系统盘，从 D 开始找
  for (const c of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${c}:\\`;
    try {
      if (existsSync(root)) found.push({ letter: `${c}:`, free: true });
    } catch {
      /* 盘符探测失败就跳过 */
    }
  }
  return found;
}

export interface UsbResult {
  ok: boolean;
  target?: string;
  error?: string;
}

/** 把最新一份备份复制到 U 盘 */
export function copyLatestToUsb(driveLetter: string): UsbResult {
  const latest = listBackups()[0];
  if (!latest) return { ok: false, error: '还没有任何备份，先备份一次' };

  if (!/^[A-Za-z]:$/.test(driveLetter)) {
    return { ok: false, error: `盘符看不懂：${driveLetter}` };
  }

  const dir = join(`${driveLetter}\\`, '烟酒台账备份');
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, latest.name);
    copyFileSync(latest.path, target);

    const check = verifyBackup(target);
    if (!check.ok) return { ok: false, error: `复制到 U 盘后校验没通过：${check.detail}` };

    return { ok: true, target };
  } catch (e) {
    return { ok: false, error: `写不进 ${driveLetter}：${(e as Error).message}` };
  }
}
