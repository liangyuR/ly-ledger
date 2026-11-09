import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';

import { api } from '../api/client';

interface SummaryItem {
  id: number;
  time: string;
  summary: string;
  amount: string;
  settleType: 'cash' | 'credit';
  customerName: string | null;
  isReturn: boolean;
  costUnknown: boolean;
}

interface Totals {
  cashSales: string;
  creditSales: string;
  cashProfit: string;
  creditProfit: string;
}

interface Summary extends Totals {
  month: string;
  costUnknownCount: number;
  days: (Totals & { date: string; items: SummaryItem[] })[];
}

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'cash', label: '现金' },
  { key: 'credit', label: '挂账' },
  { key: 'return', label: '退货' },
] as const;

const METRICS = [
  { key: 'cashSales', label: '现金销售额' },
  { key: 'creditSales', label: '挂账销售额' },
  { key: 'cashProfit', label: '现金销售毛利' },
  { key: 'creditProfit', label: '挂账销售毛利' },
] as const;

const control = 'min-h-12 rounded-[10px] border border-line bg-card px-4 text-[17px] hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-40';

function thisMonth() {
  return new Date().toLocaleDateString('sv-SE').slice(0, 7);
}

function validMonth(value: string | null): value is string {
  return !!value && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value);
}

function shiftMonth(month: string, offset: number) {
  const [year, m] = month.split('-').map(Number);
  const total = year * 12 + m - 1 + offset;
  return `${Math.floor(total / 12)}-${String(total % 12 + 1).padStart(2, '0')}`;
}

function money(value?: string) {
  if (value == null) return '—';
  const [whole, fraction] = value.split('.');
  return `${whole.startsWith('-') ? '-' : ''}¥${whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction ?? '00'}`;
}

function dateLabel(date: string) {
  return `${date.slice(5, 7)}月${date.slice(8)}日`;
}

export default function SalesSummary() {
  const [params, setParams] = useSearchParams();
  const currentMonth = thisMonth();
  const requestedMonth = params.get('month');
  const month = validMonth(requestedMonth) && requestedMonth <= currentMonth ? requestedMonth : currentMonth;
  const filter = FILTERS.find((f) => f.key === params.get('filter'))?.key ?? 'all';
  const summary = useQuery({
    queryKey: ['salesSummary', month],
    queryFn: () => api.get<Summary>(`/api/reports/sales-summary?month=${month}`),
    staleTime: 0,
  });
  const data = summary.isError ? undefined : summary.data;
  const day = data?.days.find((d) => d.date === params.get('day')) ?? data?.days[0];
  const items = day?.items.filter((item) => filter === 'all'
    || (filter === 'return' ? item.isReturn : item.settleType === filter)) ?? [];

  function changeMonth(nextMonth: string) {
    if (!validMonth(nextMonth) || nextMonth > currentMonth) return;
    setParams({ month: nextMonth }, { replace: true });
  }

  function selectDay(date: string) {
    setParams({ month, day: date }, { replace: true });
  }

  function selectFilter(nextFilter: string) {
    setParams({ month, ...(day ? { day: day.date } : {}), filter: nextFilter }, { replace: true });
  }

  return (
    <div className="flex grow flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <h1 className="m-0 text-[36px] font-semibold text-brand-900">卖货汇总</h1>
          <p className="m-0 text-[17px] text-ink-2">仅商品销售，不含桌子费</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={control} onClick={() => changeMonth(shiftMonth(month, -1))} disabled={month <= '1000-01'}>上个月</button>
          <input type="month" aria-label="汇总月份" value={month} min="1000-01" max={currentMonth}
            onChange={(e) => changeMonth(e.target.value)} className={`${control} num w-[180px]`} />
          <button type="button" className={control} onClick={() => changeMonth(shiftMonth(month, 1))} disabled={month >= currentMonth}>下个月</button>
          <button type="button" className={control} onClick={() => changeMonth(currentMonth)} disabled={month === currentMonth}>回到本月</button>
          <Link to="/sell" className="ml-2 flex min-h-12 items-center rounded-[10px] bg-brand-700 px-5 text-[17px] font-medium text-white hover:bg-brand-900">返回卖货</Link>
        </div>
      </div>

      <section aria-label="月度合计" className="grid grid-cols-1 overflow-hidden rounded-2xl border border-line bg-card sm:grid-cols-2 xl:grid-cols-4">
        {METRICS.map(({ key, label }) => (
          <div key={key} className="min-w-0 px-6 py-6 xl:border-r xl:border-line xl:last:border-r-0">
            <div className="mb-2 text-[17px] text-ink-2">{label}</div>
            <div className="num break-words text-[clamp(26px,2.4vw,38px)] leading-tight font-semibold text-brand-900">{money(data?.[key])}</div>
          </div>
        ))}
      </section>

      <p className="m-0 text-[16px] leading-relaxed text-ink-2">
        月度合计已扣除退货和抹零；挂账销售额不代表当前欠款，部分付款的单据仍计入挂账销售。
      </p>

      {!!data?.costUnknownCount && (
        <div role="status" className="rounded-xl bg-danger-50 px-5 py-4 text-[17px] text-danger">
          本月有 {data.costUnknownCount} 个商品缺少成本，毛利可能偏高，相关单据已标记。
        </div>
      )}

      {summary.isError ? (
        <section role="alert" className="rounded-2xl border border-line bg-card p-8">
          <h2 className="m-0 text-xl font-semibold">汇总暂时没加载出来</h2>
          <p className="text-[17px] text-danger">{summary.error.message}</p>
          <button type="button" className={control} onClick={() => void summary.refetch()} disabled={summary.isFetching}>重新加载</button>
        </section>
      ) : summary.isPending ? (
        <div role="status" className="rounded-2xl border border-line bg-card p-10 text-[19px] text-muted">正在读取本月销售记录…</div>
      ) : !data?.days.length ? (
        <section className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-line bg-card px-6 text-center">
          <h2 className="text-xl font-semibold">这个月还没有卖货记录</h2>
          <p className="mt-0 text-[17px] text-muted">可以切换月份查看，或返回卖货记一笔。</p>
          <Link to="/sell" className="mt-3 text-[18px] text-brand-900 underline underline-offset-4">去卖货</Link>
        </section>
      ) : (
        <div className="grid min-h-[440px] grow grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(350px,0.36fr)_minmax(0,0.64fr)]">
          <section className="min-w-0 self-stretch overflow-hidden rounded-2xl border border-line bg-card">
            <h2 className="m-0 px-6 pt-6 pb-5 text-[24px] font-semibold">按日查看</h2>
            <div className="grid grid-cols-[90px_1fr_1fr] gap-2 border-y border-line px-5 py-3 text-[15px] text-ink-2">
              <span>日期</span><span className="text-right">现金销售</span><span className="text-right">挂账销售</span>
            </div>
            <div className="max-h-[520px] overflow-auto">
              {data.days.map((row) => (
                <button key={row.date} type="button" aria-pressed={day?.date === row.date}
                  aria-label={`${dateLabel(row.date)}，现金销售 ${row.cashSales} 元，挂账销售 ${row.creditSales} 元`}
                  onClick={() => selectDay(row.date)}
                  className={`grid min-h-17 w-full grid-cols-[90px_1fr_1fr] items-center gap-2 border-b border-line px-5 py-4 text-left text-[18px] hover:bg-brand-50 ${day?.date === row.date ? 'bg-brand-50 font-semibold text-brand-900' : ''}`}>
                  <span>{dateLabel(row.date)}</span>
                  <span className="num break-all text-right">{money(row.cashSales)}</span>
                  <span className="num break-all text-right">{money(row.creditSales)}</span>
                </button>
              ))}
            </div>
          </section>

          <section aria-label="单据明细" className="flex min-w-0 flex-col self-stretch overflow-hidden rounded-2xl border border-line bg-card">
            <div className="px-6 pt-6 pb-5">
              <h2 className="m-0 mb-4 text-[24px] font-semibold">{day && dateLabel(day.date)} · 单据明细</h2>
              <div role="group" aria-label="筛选单据" className="flex flex-wrap gap-2">
                {FILTERS.map(({ key, label }) => (
                  <button key={key} type="button" aria-pressed={filter === key} onClick={() => selectFilter(key)}
                    className={`min-h-12 rounded-[10px] border px-6 text-[18px] ${filter === key ? 'border-brand-700 bg-brand-700 font-medium text-white' : 'border-line bg-card text-ink-2 hover:bg-brand-50'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto px-5">
              <table className="w-full min-w-[510px] table-fixed border-collapse text-left text-[19px]">
                <thead className="border-y border-line bg-page text-[15px] font-normal text-ink-2">
                  <tr><th className="w-18 py-3 font-normal">时间</th><th className="font-normal">商品</th><th className="w-36 text-right font-normal">金额</th><th className="w-36 pl-5 font-normal">结算</th></tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-b border-line hover:bg-brand-50">
                      <td className="num py-4 align-top text-[18px] text-ink-2">{item.time}</td>
                      <td className="py-4 pr-2 align-top">
                        <Link to={`/sales/${item.id}`} className="break-words text-brand-900 underline decoration-brand-900/30 underline-offset-4">
                          {item.isReturn ? '退货 · ' : ''}{item.summary}
                        </Link>
                        {item.costUnknown && <span className="mt-1 block text-[14px] text-danger">缺少成本</span>}
                      </td>
                      <td className={`num break-all py-4 text-right align-top ${item.isReturn ? 'text-danger' : ''}`}>{money(item.amount)}</td>
                      <td className="py-4 pl-5 align-top text-[18px] text-ink-2">
                        {item.settleType === 'credit' ? `${item.isReturn ? '挂账冲减' : '挂账'} · ${item.customerName ?? '未命名客户'}` : item.isReturn ? '现金退款' : '现金'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!items.length && <p role="status" className="px-6 py-10 text-center text-[18px] text-muted">这天没有{FILTERS.find((f) => f.key === filter)?.label}单据</p>}
            <p className="mx-5 mt-auto mb-5 rounded-lg bg-page px-4 py-3 text-center text-[15px] text-ink-2">共 {items.length} 笔 · 点击商品查看完整单据；混合单据在这里仅显示商品金额</p>
          </section>
        </div>
      )}
    </div>
  );
}
