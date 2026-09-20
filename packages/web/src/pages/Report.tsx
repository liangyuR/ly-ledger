import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { api, exportXlsx, type ExportKind } from '../api/client';
import { Card, Figure } from '../components/Card';
import { Modal } from '../components/Modal';

/** 某天开出的全部单据。现金单过了今天就只能在这儿找到 */
interface DayDocs {
  /** 看的是哪一天或哪个月 */
  period: string;
  count: number;
  /** 已经格式化好的字符串。前端不做金额运算，退货的负数也是后端冲掉的 */
  total: string;
  items: {
    id: number;
    /** 按月看时一行行跨天，光有时分认不出是哪天 */
    bizDate: string;
    time: string;
    summary: string;
    total: string;
    settleType: 'cash' | 'credit';
    customerName: string | null;
    /** 退货单，金额为负 —— 不标出来会被当成「那天卖了负数」 */
    isReturn: boolean;
  }[];
}

function today() {
  return new Date().toLocaleDateString('sv-SE');
}

/** 日期加减。中午构造，避开夏令时把日子推过界 */
function shiftDay(iso: string, by: number) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + by);
  return d.toLocaleDateString('sv-SE');
}

/** 月份加减。不拿 Date 做月运算 —— 1 月减一个月要翻年，自己算一次说清楚 */
function shiftMonth(m: string, by: number) {
  const [y, mo] = m.split('-').map(Number);
  const total = y * 12 + (mo - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** 「2026-09-20」→ 按天，「2026-09」→ 按月。一个参数表达两种粒度 */
function isMonth(period: string) {
  return period.length === 7;
}

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
    /** 这个商品有没进过货就卖掉的行，毛利虚高 */
    costUnknown: boolean;
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
  costUnknown: { productCount: number; revenue: string; names: string[] };
}

type Tab = 'trend' | 'ranking' | 'stale' | 'docs';

function XlsxButton({ kind, children }: { kind: ExportKind; children: string }) {
  return (
    <button
      type="button"
      onClick={() => void exportXlsx(kind)}
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
  const navigate = useNavigate();
  // 标签和日期记在地址栏里 —— 主页那条「看全部」要能一步跳到某天的单据，
  // 从单据点进详情再返回时也还停在原来那天
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab | null) ?? 'trend';
  // 一天（2026-09-20）或一个月（2026-09）。后端那边两种都是 biz_date 的前缀
  const period = params.get('period') ?? today();
  const month = isMonth(period);
  // 报表看哪个月。四个数字、趋势图、单品排行都跟着它
  const viewMonth = params.get('month') ?? today().slice(0, 7);
  const setViewMonth = (m: string) => {
    const next = new URLSearchParams(params);
    next.set('month', m);
    setParams(next, { replace: true });
  };

  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  const setPeriod = (p: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', 'docs');
    next.set('period', p);
    setParams(next, { replace: true });
  };

  const [exporting, setExporting] = useState(false);
  const [fromMonth, setFromMonth] = useState(viewMonth);
  const [toMonth, setToMonth] = useState(viewMonth);

  const docs = useQuery({
    queryKey: ['salesByDate', period],
    queryFn: () => api.get<DayDocs>(`/api/sales?period=${period}`),
    enabled: tab === 'docs',
  });
  const profit = useQuery({
    queryKey: ['profit', viewMonth],
    queryFn: () => api.get<Profit>(`/api/reports/profit?month=${viewMonth}`),
  });

  const d = profit.data;
  const maxProfit = Math.max(1, ...(d?.ranking ?? []).map((r) => r.profitCents));

  const TABS: { key: Tab; label: string }[] = [
    { key: 'trend', label: '毛利趋势' },
    { key: 'ranking', label: '单品排行' },
    { key: 'stale', label: '滞销预警' },
    { key: 'docs', label: '单据' },
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

        {/* 单据标签自己带日期导航，别摆两套翻页在一行里 */}
        {tab !== 'docs' && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setViewMonth(shiftMonth(viewMonth, -1))}
              aria-label="上个月"
              className="h-12 w-12 rounded-[10px] border border-line bg-card text-[18px]"
            >
              ‹
            </button>
            <span className="num w-28 text-center text-[20px]">{viewMonth}</span>
            <button
              type="button"
              onClick={() => setViewMonth(shiftMonth(viewMonth, 1))}
              disabled={viewMonth >= today().slice(0, 7)}
              aria-label="下个月"
              className="h-12 w-12 rounded-[10px] border border-line bg-card text-[18px] disabled:opacity-40"
            >
              ›
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            setFromMonth(viewMonth);
            setToMonth(viewMonth);
            setExporting(true);
          }}
          className="flex h-12 items-center gap-2.5 rounded-[10px] border border-line bg-card px-5 text-[17px]"
        >
          导出明细
        </button>
      </div>

      <div className="flex shrink-0 gap-5">
        {/* 趋势图最后一根柱子就是选中的那个月，两个数字取的是同一份 */}
        <Figure label="毛利" value={`¥${d?.monthly.at(-1)?.profit ?? '—'}`} tone="brand" sub={viewMonth} />
        <Figure label="营业额" value={`¥${d?.monthly.at(-1)?.revenue ?? '—'}`} sub={viewMonth} />
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

      {(d?.costUnknown.productCount ?? 0) > 0 && (
        <div className="shrink-0 rounded-2xl bg-danger-50 px-7 py-5 text-[18px] leading-relaxed text-ink-2">
          <strong className="font-semibold text-danger">这个月的毛利偏高，不能当真。</strong>
          {' '}有 <span className="num">{d?.costUnknown.productCount}</span> 个商品是没进过货就卖掉的，
          软件不知道你当初花多少钱进的，这部分毛利按全额售价算了，涉及销售额{' '}
          <span className="num font-semibold">¥{d?.costUnknown.revenue}</span>。
          <div className="mt-2 text-[17px]">
            {d?.costUnknown.names.join('、')}
            {(d?.costUnknown.productCount ?? 0) > (d?.costUnknown.names.length ?? 0) && ' 等'}
            {' '}—— 这些商品下次进货时，成本就自动校正了，不用手工改。
          </div>
        </div>
      )}

      {/* 导出：一个月发给会计，多个月自己对账。范围默认就是当前看的那个月 */}
      <Modal open={exporting} onClose={() => setExporting(false)} title="导出销售明细">
        <div className="mb-4 flex items-end gap-3">
          <label className="flex flex-col gap-1.5 text-[16px] text-ink-2">
            从
            <input
              type="month"
              value={fromMonth}
              onChange={(e) => setFromMonth(e.target.value)}
              aria-label="从哪个月"
              className="num h-13 w-[170px] rounded-[10px] border border-line bg-card px-3 text-[19px]"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[16px] text-ink-2">
            到
            <input
              type="month"
              value={toMonth}
              onChange={(e) => setToMonth(e.target.value)}
              aria-label="到哪个月"
              className="num h-13 w-[170px] rounded-[10px] border border-line bg-card px-3 text-[19px]"
            />
          </label>
        </div>

        <div className="rounded-xl bg-page px-5 py-4 text-[16px] leading-relaxed text-ink-2">
          {fromMonth === toMonth
            ? '一个月一份表，逐笔明细，直接发给会计。'
            : '跨月会多一页「按月汇总」：每个月一行，底下带合计 —— 不用自己把几份表摞起来加。'}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => setExporting(false)}
            className="h-13 rounded-[10px] border border-line bg-card px-5 text-[18px]"
          >
            不导了
          </button>
          <button
            type="button"
            onClick={() => {
              setExporting(false);
              if (fromMonth === toMonth) void exportXlsx('sales', { month: fromMonth });
              else void exportXlsx('sales_range', { fromMonth, toMonth });
            }}
            className="h-13 rounded-[10px] bg-brand-700 px-6 text-[18px] font-semibold text-white"
          >
            导出
          </button>
        </div>
      </Modal>

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
              <XlsxButton kind="ranking">导出排行</XlsxButton>
            </div>
            {(d?.ranking.length ?? 0) === 0 && <div className="text-[17px] text-muted">本月还没有销售</div>}
            {d?.ranking.map((r) => (
              <div key={r.productId} className="flex h-14 items-center gap-4 border-t border-line">
                <span className="w-44 truncate text-[18px]">{r.name}</span>
                {/* 虚高的毛利要逐行标，不能只在顶上说一句 —— 老板看的是这一行 */}
                <span
                  className={`w-20 shrink-0 text-[15px] ${r.costUnknown ? 'text-danger' : 'text-transparent'}`}
                >
                  {r.costUnknown ? '成本未知' : ''}
                </span>
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
              <XlsxButton kind="stale">导出滞销表</XlsxButton>
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

        {tab === 'docs' && (
          <Card
            title="单据"
            extra={
              <span className="text-[17px] text-ink-2">
                点一行打开单据，可改可退
                <span className="text-muted">现金单过了今天只能在这儿找</span>
              </span>
            }
          >
            <div className="mb-4 flex items-center gap-2.5">
              {/* 按天是「昨天那单在哪」，按月是「这个月开了多少单」—— 两种翻法 */}
              <div className="mr-1.5 flex gap-1.5">
                {([
                  { on: !month, label: '按天' },
                  { on: month, label: '按月' },
                ] as const).map((b) => (
                  <button
                    key={b.label}
                    type="button"
                    onClick={() =>
                      // 切到按月就砍掉日；切回按天，本月落在今天，别的月落在 1 号
                      setPeriod(
                        b.label === '按月'
                          ? period.slice(0, 7)
                          : period === today().slice(0, 7)
                            ? today()
                            : `${period}-01`,
                      )
                    }
                    className={`h-12 rounded-[10px] border px-4 text-[17px] ${
                      b.on
                        ? 'border-brand-700 bg-brand-50 font-semibold text-brand-900'
                        : 'border-line text-ink-2'
                    }`}
                  >
                    {b.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() =>
                  setPeriod(month ? shiftMonth(period, -1) : shiftDay(period, -1))
                }
                aria-label={month ? '上个月' : '前一天'}
                className="h-12 w-12 rounded-[10px] border border-line bg-card text-[18px]"
              >
                ‹
              </button>
              {month ? (
                <span className="num w-[190px] text-center text-[21px]">{period}</span>
              ) : (
                <input
                  type="date"
                  value={period}
                  onChange={(e) => e.target.value && setPeriod(e.target.value)}
                  aria-label="哪一天"
                  className="num h-12 w-[190px] rounded-[10px] border border-line bg-card px-3 text-[19px]"
                />
              )}
              <button
                type="button"
                onClick={() => setPeriod(month ? shiftMonth(period, 1) : shiftDay(period, 1))}
                disabled={month ? period >= today().slice(0, 7) : period >= today()}
                aria-label={month ? '下个月' : '后一天'}
                className="h-12 w-12 rounded-[10px] border border-line bg-card text-[18px] disabled:opacity-40"
              >
                ›
              </button>
              {period !== today() && period !== today().slice(0, 7) && (
                <button
                  type="button"
                  onClick={() => setPeriod(month ? today().slice(0, 7) : today())}
                  className="h-12 rounded-[10px] px-3 text-[16px] text-muted underline decoration-dotted underline-offset-4 hover:text-brand-900"
                >
                  {month ? '回到本月' : '回到今天'}
                </button>
              )}
              <span className="grow" />
              <span className="text-[18px] text-ink-2">
                共 <span className="num">{docs.data?.count ?? 0}</span> 单
              </span>
              <span className="num text-[26px] font-semibold">¥{docs.data?.total ?? '0.00'}</span>
            </div>

            {(docs.data?.items.length ?? 0) === 0 && (
              <div className="border-t border-line pt-4 text-[17px] text-muted">
                {period === today() ? '今天还没开张' : month ? '这个月没有单据' : '这天没有单据'}
              </div>
            )}
            {docs.data?.items.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => navigate(`/sales/${r.id}`)}
                className="flex h-16 w-full items-center gap-4 border-t border-line text-left hover:bg-brand-50"
              >
                {/* 按月看时一行行跨天，得把日子写出来 */}
                <span className="num w-20 text-[17px] text-ink-2">
                  {month ? r.bizDate.slice(5) : r.time}
                </span>
                {/* 退货单金额为负，不标一下会被当成「那天卖了负数」 */}
                {r.isReturn && (
                  <span className="shrink-0 rounded-md bg-page px-2 py-0.5 text-[14px] text-ink-2">
                    退货
                  </span>
                )}
                <span className="grow truncate text-[19px]">{r.summary}</span>
                <span
                  className={`num w-32 text-right text-[22px] font-medium ${
                    r.isReturn ? 'text-ink-2' : ''
                  }`}
                >
                  ¥{r.total}
                </span>
                <span className="w-36 shrink-0 truncate text-right text-[16px] text-ink-2">
                  {r.settleType === 'credit' ? `挂账 · ${r.customerName ?? ''}` : '现金'}
                </span>
              </button>
            ))}
          </Card>
        )}
      </div>

    </div>
  );
}
