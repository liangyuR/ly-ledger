import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../api/client';
import { Card } from '../components/Card';
import { Flash } from '../components/Flash';

interface BackupStatus {
  lastBackupAt: string | null;
  lastBackupFile: string | null;
  ageDays: number | null;
  stale: boolean;
  count: number;
  /** 备份文件放在哪个目录。出事那天要照着它去资源管理器里找文件 */
  dir: string;
  /** 后端总会给这个数组，但少一层保护就是一次白屏 —— 崩在备份页尤其糟 */
  files?: { name: string; sizeBytes: number }[];
}

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

/** 「今天 02:00」/「3 天前」—— 要的是「多久没备份了」，不是时间戳 */
function describe(s: BackupStatus | undefined): string {
  if (!s) return '…';
  if (!s.lastBackupAt) return '从没备份过';
  const t = new Date(s.lastBackupAt);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (s.ageDays === 0) return `今天 ${hhmm}`;
  if (s.ageDays === 1) return `昨天 ${hhmm}`;
  return `${s.ageDays} 天前`;
}

export default function Backup() {
  const qc = useQueryClient();
  const [flash, setFlash] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [drive, setDrive] = useState('');

  const status = useQuery({
    queryKey: ['backupStatus'],
    queryFn: () => api.get<BackupStatus>('/api/backup/status'),
  });
  const drives = useQuery({
    queryKey: ['drives'],
    queryFn: () => api.get<{ drives: { letter: string }[] }>('/api/backup/drives'),
  });

  const now = useMutation({
    mutationFn: () => api.post<{ file: string; sizeBytes: number }>('/api/backup/now'),
    onSuccess: (r) => {
      setFlash({ tone: 'ok', text: `备好了：${r.file}（${mb(r.sizeBytes)}），已校验可用` });
      qc.invalidateQueries({ queryKey: ['backupStatus'] });
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  const toUsb = useMutation({
    mutationFn: () => api.post<{ target: string }>('/api/backup/to-usb', { drive }),
    onSuccess: (r) => setFlash({ tone: 'ok', text: `已复制到 ${r.target}，并校验过` }),
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  const s = status.data;

  return (
    <div className="flex min-h-0 grow flex-col gap-5">
      <div className="flex shrink-0 items-center gap-4">
        <h1 className="m-0 text-2xl font-semibold">备份</h1>
        <span className="text-[17px] text-ink-2">平时不用管，软件每天凌晨自动备一次</span>
      </div>

      <div className="flex min-h-0 grow gap-5">
        <Card className="flex grow flex-col overflow-hidden">
          <div className="mb-5 flex shrink-0 items-baseline">
            <span className="mr-3.5 text-[18px] text-ink-2">最近一次</span>
            <span
              className={`num text-[42px] leading-none font-semibold ${
                s?.stale ? 'text-danger' : ''
              }`}
            >
              {describe(s)}
            </span>
            <span className="grow" />
            <span className="text-[17px] text-ink-2">
              {s?.lastBackupFile ? `${s.lastBackupFile}，共 ${s.count} 份` : '还没有任何备份'}
            </span>
          </div>

          {/* 不只靠颜色：标红时同时给出一句话 */}
          {s?.stale && (
            <div className="mb-5 shrink-0 rounded-xl bg-danger-50 px-5 py-3.5 text-[17px] text-danger">
              {s.lastBackupAt ? `已经 ${s.ageDays} 天没有成功备份了。` : '一次都还没备份过。'}
              硬盘坏了就是几年台账全没 —— 现在点一下就好。
            </div>
          )}

          <div className="flex shrink-0 items-end gap-4">
            <button
              type="button"
              onClick={() => now.mutate()}
              disabled={now.isPending}
              className="h-14 rounded-xl bg-brand-700 px-7 text-[19px] font-semibold text-white disabled:opacity-60"
            >
              {now.isPending ? '备份中…' : '立即备份'}
            </button>

            <label className="flex flex-col gap-2 text-[16px] text-ink-2">
              备份到 U 盘
              <select
                value={drive}
                onChange={(e) => setDrive(e.target.value)}
                aria-label="选盘符"
                className="h-14 w-36 rounded-xl border border-line bg-card px-3 text-[18px]"
              >
                <option value="">选盘符</option>
                {drives.data?.drives.map((d) => (
                  <option key={d.letter} value={d.letter}>
                    {d.letter}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => toUsb.mutate()}
              disabled={!drive || toUsb.isPending}
              className="h-14 rounded-xl border border-line bg-card px-6 text-[19px] font-semibold disabled:opacity-40"
            >
              {toUsb.isPending ? '复制中…' : '复制过去'}
            </button>
          </div>

          <Flash value={flash} className="mt-4 shrink-0" />

          <div className="mt-5 shrink-0 rounded-xl bg-page px-5 py-4 text-[16px] leading-relaxed text-ink-2">
            本机备份防不了硬盘损坏 —— 硬盘坏了，备份和原件一起没。
            <br />
            准备一个 U 盘常插着，每周点一次「复制过去」。
          </div>

          <div className="mt-5 flex h-12 shrink-0 items-center gap-4 border-t border-line text-[17px] text-ink-2">
            <span className="grow">备份文件</span>
            <span className="num">{s?.count ?? 0} 份</span>
          </div>

          <div className="min-h-0 grow overflow-auto">
            {(s?.files?.length ?? 0) === 0 && (
              <div className="pt-4 text-[17px] text-muted">还没有备份文件</div>
            )}
            {s?.files?.map((f) => (
              <div key={f.name} className="flex h-14 items-center gap-4 border-t border-line">
                <span className="num grow text-[19px]">{f.name}</span>
                <span className="num text-[17px] text-ink-2">{mb(f.sizeBytes)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="万一出事了" className="flex w-[560px] shrink-0 flex-col overflow-auto">
          <div className="mb-5 text-[17px] leading-relaxed text-ink-2">
            数据乱了但电脑还能用，照下面四步做。真到那天你多半没法在这台电脑上看文档，
            所以<span className="font-semibold text-ink">把这一页打印一份压在柜台下面</span>。
          </div>

          <ol className="m-0 flex flex-col gap-3.5 pl-6 text-[18px] leading-relaxed">
            <li>
              <span className="font-semibold">关掉软件</span> —— 点窗口右上角的 ×，
              确认任务栏里没有它了
            </li>
            <li>
              <span className="font-semibold">换文件</span> —— 从备份目录里挑一个日期的{' '}
              <span className="num">.db</span>，复制到 <span className="num">data\</span> 下面，
              改名成 <span className="num">ledger.db</span>，覆盖原来那个
            </li>
            <li>
              <span className="font-semibold">
                把 <span className="num">data\</span> 里的{' '}
                <span className="num">ledger.db-wal</span> 和{' '}
                <span className="num">ledger.db-shm</span> 删掉
              </span>
              （有就删，没有就算）
            </li>
            <li>
              <span className="font-semibold">重新打开软件</span>，确认数据回到了那一天的样子
            </li>
          </ol>

          <div className="mt-5 rounded-xl bg-danger-50 px-5 py-4 text-[16px] leading-relaxed text-danger">
            第 3 步不能省。那两个是数据库的草稿本，记的是旧账 —— 留着它们，
            换进去的备份会被旧草稿盖回去。
          </div>

          <div className="mt-5 text-[16px] leading-relaxed text-muted">
            <span className="text-ink-2">备份文件在这儿</span>
            <br />
            <span className="num break-all">{s?.dir ?? '…'}</span>
          </div>

          <div className="mt-5 border-t border-line pt-4 text-[16px] leading-relaxed text-muted">
            别直接复制 <span className="num">ledger.db</span> 当备份 ——
            软件正往里写的时候复制，会得到一个看着正常、其实打不开的文件。
            上面那个「立即备份」走的是数据库自己的在线备份接口，任何时候点都是完整的。
          </div>
        </Card>
      </div>
    </div>
  );
}
