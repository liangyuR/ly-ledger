import { NavLink, useNavigate } from 'react-router-dom';

import { useHotkeys } from '../hooks/useHotkeys';

const NAV = [
  { to: '/sell', key: 'F1', label: '卖货' },
  { to: '/purchase', key: 'F2', label: '进货' },
  { to: '/collect', key: 'F3', label: '收款' },
  { to: '/report', key: 'F4', label: '报表' },
  { to: '/products', key: 'F5', label: '商品' },
];

export default function TopBar({ backupAt }: { backupAt?: string }) {
  const navigate = useNavigate();

  // 功能键在输入框里也要响应 —— 手停在数量框上按 F2 必须直接跳进货
  useHotkeys(Object.fromEntries(NAV.map((n) => [n.key, () => navigate(n.to)])));

  return (
    <header className="flex h-21 shrink-0 items-center gap-7 overflow-x-auto border-b border-line bg-card px-10">
      <NavLink to="/" className="shrink-0 text-2xl font-semibold whitespace-nowrap text-brand-900">
        烟酒台账
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
            {({ isActive }) => (
              <>
                <span className={`num text-[13px] font-medium ${isActive ? 'text-brand-500' : 'text-muted'}`}>
                  {item.key}
                </span>
                {item.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* 备份状态常驻可见。静默失败的备份等于没有备份（docs/03） */}
      <div className="flex shrink-0 items-center gap-2.5 text-[17px] whitespace-nowrap text-ink-2">
        <span className="block size-2.5 rounded-full bg-brand-500" />
        备份　<span className="num">{backupAt ?? '未配置'}</span>
      </div>
    </header>
  );
}
