import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../api/client';
import { Card, Figure } from '../components/Card';

interface Profit {
  month: string;
  monthly: { month: string; revenue: string; profit: string; profitCents: number; partial: boolean }[];
  ranking: {
    productId: number;
    name: string;
    qty: string;
    revenue: string;
    profit: string;
    profitCents: number;
    margin: string | null;
  }[];
  stale: {
    productId: number;
    name: string;
    qty: string;
    value: string;
    lastSoldDate: string | null;
    idleDays: number | null;
  }[];
  inventory: { totalValue: string; skuCount: number; negativeCount: number };
}

type Tab = 'trend' | 'ranking' | 'stale';

/** 下载不走 fetch —— 让浏览器自己处理 Content-Disposition，文件名才对 */
function download(path: string) {
  window.location.href = path;
}

function XlsxButton({ href, children }: { href: string; children: string }) {
  return (
    <button
      type="button"
      onClick={() => download(href)}
      className="flex h-12 items-center gap-2.5 rounded-[10px] border border-line bg-card px-5 text-[17px]"
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="text-brand-700"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="M7 10l5 5 5-5" />
        <path d="M12 15V3" />
      </svg>
      {children}
    </button>
  );
}

/**
 * 月毛利趋势。
 *
 * 单系列柱状图，一个颜色就够 —— 两个系列才需要图例。
 * 本月是空心柱：它还没走完，跟完整月份比高低没有意义。
 * 只给最后一根直接标数，不是每根都标 —— 每根都标等于没标。
 */
function TrendChart({ data }: { data: Profit['monthly'] }) {
  const max = Math.max(1, ...data.map((d) => d.profitCents));
  const PLOT = 280;

  return (
    <div className="flex items-end gap-8 px-2 pt-10">
      {data.map((d) => {
        const h = Math.round((d.profitCents / max) * PLOT);
        return (
          <div key={d.month} className="flex w-24 flex-col items-center gap-3">
            <div className="flex w-full items-end" style={{ height: PLOT + 38 }}>
              <div
                className={`relative w-full rounded-t ${
                  d.partial ? 'border-2 border-brand-500 bg-brand-50' : 'bg-brand-500'
                }`}
                style={{ height: Math.max(h, 2) }}
              >
                {d.partial && (
                  <div className="num absolute -top-8 left-1/2 -translate-x-1/2 text-[17px] font-semibold whitespace-nowrap text-brand-900">
                    ¥{d.profit}
                  </div>
                )}
              </div>
            </div>
            <span className="num text-[16px] text-ink-2">{d.month.slice(5)} 月</span>
          </div>
        );
      })}
    </div>
  );
}

export default function Report() {
  const [tab, setTab] = useState<Tab>('trend');
  const profit = useQuery({ queryKey: ['profit'], queryFn: () => api.get<Profit>('/api/reports/profit') });

  const d = profit.data;
  const maxProfit = Math.max(1, ...(d?.ranking ?? []).map((r) => r.profitCents));

  const TABS: { key: Tab; label: string }[] = [
    { key: 'trend', label: '毛利趋势' },
    { key: 'ranking', label: '单品排行' },
    { key: 'stale', label: '滞销预警' },
  ];

  return (
    <div className="flex min-h-0 grow flex-col gap-5">
      <div className="flex shrink-0 items-center gap-4">
        <h1 className="m-0 text-2xl font-semibold">报表</h1>
        <div className="ml-4 flex gap-2.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`h-13 rounded-[10px] border px-6 text-[19px] ${
                tab === t.key
                  ? 'border-brand-700 bg-brand-50 font-semibold text-brand-900'
                  : 'border-line text-ink-2'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <XlsxButton href="/api/reports/export">导出本月明细</XlsxButton>
      </div>

      <div className="flex shrink-0 gap-5">
        <Figure label="本月毛利" value={`¥${d?.monthly.at(-1)?.profit ?? '—'}`} tone="brand" sub={d?.month} />
        <Figure label="本月营业额" value={`¥${d?.monthly.at(-1)?.revenue ?? '—'}`} />
        <Figure
          label="库存金额"
          value={`¥${d?.inventory.totalValue ?? '—'}`}
          sub={`${d?.inventory.skuCount ?? 0} 个商品有货`}
        />
        <Figure
          label="滞销"
          value={`${d?.stale.length ?? 0} 个`}
          sub="超 90 天未动"
          tone={(d?.stale.length ?? 0) > 0 ? 'danger' : 'ink'}
        />
      </div>

      <div className="min-h-0 grow overflow-auto">
        {tab === 'trend' && (
          <Card
            title="月毛利趋势"
            extra={
              <span className="text-[17px] text-ink-2">
                最近 6 个月　<span className="text-muted">本月为至今，空心柱</span>
              </span>
            }
          >
            {d && <TrendChart data={d.monthly} />}
          </Card>
        )}

        {tab === 'ranking' && (
          <Card
            title="单品毛利排行"
            extra={
              <span className="text-[17px] text-ink-2">
                本月 · 按毛利额　<span className="text-muted">卖得多不等于赚得多</span>
              </span>
            }
          >
            <div className="mb-3 flex justify-end">
              <XlsxButton href="/api/reports/export-ranking">导出排行</XlsxButton>
            </div>
            {(d?.ranking.length ?? 0) === 0 && <div className="text-[17px] text-muted">本月还没有销售</div>}
            {d?.ranking.map((r) => (
              <div key={r.productId} className="flex h-14 items-center gap-4 border-t border-line">
                <span className="w-44 text-[18px]">{r.name}</span>
                <span className="num w-24 text-[16px] text-ink-2">{r.qty}</span>
                <div className="h-4.5 grow overflow-hidden rounded bg-page">
                  <div
                    className="h-full rounded bg-brand-500"
                    style={{ width: `${Math.round((r.profitCents / maxProfit) * 100)}%` }}
                  />
                </div>
                <span className="num w-24 text-right text-[16px] text-ink-2">{r.margin ?? '—'}%</span>
                <span className="num w-28 text-right text-[18px]">¥{r.profit}</span>
              </div>
            ))}
          </Card>
        )}

        {tab === 'stale' && (
          <Card
            title="滞销预警"
            extra={<span className="text-[17px] text-ink-2">有货但超 90 天没卖动，按压的钱排序</span>}
          >
            <div className="mb-3 flex justify-end">
              <XlsxButton href="/api/reports/export-stale">导出滞销表</XlsxButton>
            </div>
            {(d?.stale.length ?? 0) === 0 && <div className="text-[17px] text-muted">没有滞销的货</div>}
            {d?.stale.map((s) => (
              <div key={s.productId} className="flex h-14 items-center gap-4 border-t border-line">
                <span className="w-52 text-[18px]">{s.name}</span>
                <span className="num w-28 text-[16px] text-ink-2">{s.qty}</span>
                <span className="grow" />
                <span className="w-44 text-right text-[16px] text-ink-2">
                  {s.lastSoldDate ? `最后卖出 ${s.lastSoldDate}` : '从没卖过'}
                </span>
                <span className="num w-24 text-right text-[16px] text-ink-2">
                  {s.idleDays == null ? '—' : `${s.idleDays} 天`}
                </span>
                <span className="num w-28 text-right text-[18px] text-danger">¥{s.value}</span>
              </div>
            ))}
          </Card>
        )}
      </div>

      <div className="shrink-0 text-[16px] text-muted">
        这里的每一个数字都是<strong className="font-semibold text-ink-2">毛利</strong>：售价 −
        进价。不含房租、水电、人工，不是你真正赚到的钱。
      </div>
    </div>
  );
}
