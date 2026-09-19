import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../api/client';
import { Card } from './Card';

interface BackupStatus {
  lastBackupAt: string | null;
  lastBackupFile: string | null;
  ageDays: number | null;
  stale: boolean;
  count: number;
  dir: string;
  files: { name: string; sizeBytes: number }[];
}

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

export default function BackupCard() {
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

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['backupStatus'] });
  };

  const now = useMutation({
    mutationFn: () => api.post<{ file: string; sizeBytes: number }>('/api/backup/now'),
    onSuccess: (r) => {
      setFlash({ tone: 'ok', text: `备好了：${r.file}（${mb(r.sizeBytes)}），已校验可用` });
      refresh();
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
    <Card
      title="备份"
      extra={
        <span className={`text-[17px] ${s?.stale ? 'text-danger' : 'text-ink-2'}`}>
          {s?.lastBackupFile ? `最近 ${s.lastBackupFile}，共 ${s.count} 份` : '还没有任何备份'}
        </span>
      }
      className="shrink-0"
    >
      {s?.stale && (
        <div className="mb-4 rounded-xl bg-danger-50 px-5 py-3.5 text-[17px] text-danger">
          {s.lastBackupAt
            ? `已经 ${s.ageDays} 天没有成功备份了。`
            : '一次都还没备份过。'}
          硬盘坏了就是几年台账全没 —— 现在点一下就好。
        </div>
      )}

      <div className="flex items-end gap-4">
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

        <span className="grow" />
        <span className="max-w-[420px] text-[15px] leading-relaxed text-muted">
          本机备份防不了硬盘损坏 —— 硬盘坏了，备份和原件一起没。
          <br />
          准备一个 U 盘常插着，每周复制一次。
        </span>
      </div>

      {flash && (
        <div
          className={`mt-4 rounded-xl px-5 py-3.5 text-[17px] ${
            flash.tone === 'ok' ? 'bg-brand-50 text-brand-900' : 'bg-danger-50 text-danger'
          }`}
        >
          {flash.text}
        </div>
      )}

      {(s?.files.length ?? 0) > 0 && (
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1.5 text-[15px] text-muted">
          {s?.files.slice(0, 6).map((f) => (
            <span key={f.name} className="num">
              {f.name} · {mb(f.sizeBytes)}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}
