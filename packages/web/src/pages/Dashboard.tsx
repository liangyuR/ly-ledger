import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { api } from '../api/client';
import BackupCard from '../components/BackupCard';
import { Card, Figure } from '../components/Card';

interface Dashboard {
  date: string;
  todayRevenue: string;
  todayProfit: string;
  monthProfit: string;
  inventoryValue: string;
  debtTotal: string;
  debtCount: number;
  alerts: { kind: 'negative_stock' | 'missing_price' | 'stale'; count: number; detail: string }[];
  recentSales: {
    id: number;
    time: string;
    summary: string;
    total: string;
    settleType: 'cash' | 'credit';
    customerName: string | null;
  }[];
}

interface DebtList {
  owing: { customerId: number; name: string; amount: string; agingDays: number | null }[];
  totalOwing: string;
}

const ALERT_TITLE = {
  negative_stock: (n: number) => `${n} 个商品库存为负`,
  missing_price: (n: number) => `${n} 个商品还没填价格`,
  stale: (n: number) => `${n} 个商品超 90 天未动`,
};

function WarnIcon({ danger }: { danger: boolean }) {
  if (!danger) return <span className="mt-2 block size-2.5 shrink-0 rounded-full bg-muted" />;
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-danger"
    >
      <path d="M10.3 3.5 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const board = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<Dashboard>('/api/reports/dashboard'),
  });
  const debts = useQuery({
    queryKey: ['debts'],
    queryFn: () => api.get<DebtList>('/api/customers/debts'),
  });

  if (board.isError) {
    return (
      <Card title="连不上后台">
        <p className="m-0 text-[19px] text-danger">{(board.error as Error).message}</p>
        <p className="mt-3 mb-0 text-[17px] text-ink-2">
          开发期先起后端：<code className="num">npm start</code>
        </p>
      </Card>
    );
  }

  const d = board.data;
  const owing = debts.data?.owing ?? [];

  return (
    <>
      <div className="flex shrink-0 gap-5">
        <Figure label="今日营业额" value={`¥${d?.todayRevenue ?? '—'}`} sub={d?.date} />
        <Figure label="今日毛利" value={`¥${d?.todayProfit ?? '—'}`} tone="brand" />
        <Figure label="本月毛利" value={`¥${d?.monthProfit ?? '—'}`} tone="brand" />
        <Figure label="库存金额" value={`¥${d?.inventoryValue ?? '—'}`} sub="按加权成本" />
      </div>

      <div className="-mt-2 shrink-0 text-[16px] text-muted">
        毛利 = 售价 − 成本，<strong className="font-semibold text-ink-2">不含房租、水电、人工</strong>
      </div>

      <div className="flex min-h-0 gap-5">
        <Card
          title="待收欠款"
          extra={
            <span className="text-[17px] text-ink-2">
              {owing.length} 人 · 按账龄倒序，拖最久的在最上面
            </span>
          }
          className="flex grow-[1.35] flex-col overflow-hidden"
        >
          <div className="num mb-2 text-[42px] leading-none font-semibold">
            ¥{debts.data?.totalOwing ?? '0.00'}
          </div>
          <div className="min-h-0 grow overflow-auto">
            {owing.length === 0 && <div className="pt-4 text-[17px] text-muted">没人欠钱</div>}
            {owing.map((c) => {
              const old = (c.agingDays ?? 0) > 30;
              return (
                <div key={c.customerId} className="flex h-17 items-center gap-4.5 border-t border-line">
                  <span className="w-28 text-[20px]">{c.name}</span>
                  <span className="num text-[28px] font-medium">¥{c.amount}</span>
                  {/* 账龄用天数说话，不只靠颜色 —— 色盲的人也要能看出谁拖得久 */}
                  <span
                    className={`num rounded-lg px-3 py-1.5 text-[18px] ${
                      old ? 'bg-danger-50 text-danger' : 'bg-page text-ink-2'
                    }`}
                  >
                    {c.agingDays ?? 0} 天
                  </span>
                  <span className="grow" />
                  <button
                    type="button"
                    onClick={() => navigate('/collect')}
                    className="h-12 rounded-[10px] border border-line bg-card px-6 text-[18px]"
                  >
                    收款
                  </button>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="需要注意" className="flex grow flex-col overflow-hidden">
          <div className="min-h-0 grow overflow-auto">
            {(d?.alerts.length ?? 0) === 0 && (
              <div className="text-[17px] text-muted">没什么要紧的</div>
            )}
            {d?.alerts.map((a) => (
              <div key={a.kind} className="flex gap-3.5 border-t border-line py-4 first:border-t-0">
                <WarnIcon danger={a.kind !== 'stale'} />
                <div>
                  <div className="text-[19px]">{ALERT_TITLE[a.kind](a.count)}</div>
                  <div className="mt-1 text-[16px] text-ink-2">{a.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <BackupCard />

      <Card
        title="今日流水"
        extra={<span className="text-[17px] text-muted">点一行打开单据，可改可退</span>}
        className="shrink-0"
      >
        {(d?.recentSales.length ?? 0) === 0 && (
          <div className="text-[17px] text-muted">今天还没开张</div>
        )}
        {d?.recentSales.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => navigate(`/sales/${s.id}`)}
            className="flex h-13 w-full items-center gap-6 border-t border-line text-left text-[19px] hover:bg-page"
          >
            <span className="num w-16 text-ink-2">{s.time}</span>
            <span className="w-52">{s.summary}</span>
            <span className="grow" />
            <span className="num text-[22px] font-medium">¥{s.total}</span>
            <span
              className={`w-36 text-right text-[17px] ${
                s.settleType === 'credit' ? 'text-danger' : 'text-ink-2'
              }`}
            >
              {s.settleType === 'credit' ? `挂账 · ${s.customerName ?? ''}` : '现金'}
            </span>
          </button>
        ))}
      </Card>
    </>
  );
}
