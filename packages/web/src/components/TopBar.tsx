import { useQuery } from '@tanstack/react-query';
import { NavLink, useNavigate } from 'react-router-dom';

import { api } from '../api/client';
import { useHotkeys } from '../hooks/useHotkeys';

interface BackupStatus {
  lastBackupAt: string | null;
  ageDays: number | null;
  stale: boolean;
  count: number;
}

/** "今天 02:00" / "3 天前" —— 老板要的是"多久没备份了"，不是时间戳 */
function describe(s: BackupStatus | undefined): string {
  if (!s) return '…';
  if (!s.lastBackupAt) return '从没备份过';
  const t = new Date(s.lastBackupAt);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (s.ageDays === 0) return `今天 ${hhmm}`;
  if (s.ageDays === 1) return `昨天 ${hhmm}`;
  return `${s.ageDays} 天前`;
}

const NAV: { to: string; key?: string; label: string }[] = [
  { to: '/sell', key: 'F1', label: '卖货' },
  { to: '/purchase', key: 'F2', label: '库存' },
  { to: '/collect', key: 'F3', label: '挂账归还' },
  { to: '/expense', key: 'F4', label: '开支' },
  // 桌子费不给功能键：F7 / F9 在卖货页已经是部分付和挂账，全局再绑一个会两个一起触发
  { to: '/fee', label: '桌子费' },
  { to: '/report', key: 'F5', label: '报表' },
  { to: '/products', key: 'F6', label: '商品' },
  // 不常用，但出事那天要找得到 —— 所以留在导航里，不塞进设置
  { to: '/backup', label: '备份' },
];

export default function TopBar() {
  const navigate = useNavigate();

  const backup = useQuery({
    queryKey: ['backupStatus'],
    queryFn: () => api.get<BackupStatus>('/api/backup/status'),
    refetchInterval: 5 * 60_000,
  });
  const stale = backup.data?.stale ?? false;

  // 功能键在输入框里也要响应 —— 手停在数量框上按 F2 必须直接跳库存页
  useHotkeys(Object.fromEntries(NAV.filter((n) => n.key).map((n) => [n.key, () => navigate(n.to)])));

  return (
    <header className="flex h-21 shrink-0 items-center gap-7 overflow-x-auto border-b border-line bg-card px-10">
      <NavLink to="/" className="shrink-0 text-2xl font-semibold whitespace-nowrap text-brand-900">
        主页
      </NavLink>

      <nav className="flex grow gap-1">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex shrink-0 items-center gap-2 rounded-[10px] px-5 py-3 text-[19px] whitespace-nowrap ${
                isActive ? 'bg-brand-50 font-semibold text-brand-900' : 'text-ink-2'
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* 备份状态常驻可见，超过 3 天标红。静默失败的备份等于没有备份（docs/03） */}
      <button
        type="button"
        onClick={() => navigate('/backup')}
        className={`flex shrink-0 items-center gap-2.5 rounded-[10px] px-3 py-2 text-[17px] whitespace-nowrap ${
          stale ? 'bg-danger-50 text-danger' : 'text-ink-2'
        }`}
        title={stale ? '超过 3 天没有成功备份了' : undefined}
      >
        <span className={`block size-2.5 rounded-full ${stale ? 'bg-danger' : 'bg-brand-500'}`} />
        备份　<span className="num">{describe(backup.data)}</span>
        {/* 不只靠颜色：标红时同时给出文字 */}
        {stale && <span className="font-semibold">该备份了</span>}
      </button>
    </header>
  );
}
