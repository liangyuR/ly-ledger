import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { api, exportXlsx } from '../api/client';
import { Card } from '../components/Card';
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

/**
 * 单据：查看所有订单的地方，从原来「报表」页的「单据」标签页拆出来单独成页 ——
 * 毛利趋势、单品排行、滞销预警那几个统计功能先不上导航了（代码还在 Report.tsx，
 * 没删，回头要用直接接回来），但「查所有订单」是天天要用的，配不上埋在一个
 * 四个标签的报表页里。
 */
export default function Docs() {
  const navigate = useNavigate();
  // 看哪一天/哪个月记在地址栏里 —— 主页那条「看全部」要能一步跳到某天的单据
  const [params, setParams] = useSearchParams();
  const period = params.get('period') ?? today();
  const month = period.length === 7;
  const setPeriod = (p: string) => {
    const next = new URLSearchParams(params);
    next.set('period', p);
    setParams(next, { replace: true });
  };

  const [exporting, setExporting] = useState(false);
  const [fromMonth, setFromMonth] = useState(period.slice(0, 7));
  const [toMonth, setToMonth] = useState(period.slice(0, 7));

  const docs = useQuery({
    queryKey: ['salesByDate', period],
    queryFn: () => api.get<DayDocs>(`/api/sales?period=${period}`),
  });

  return (
    <div className="flex min-h-0 grow flex-col gap-5">
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
        <Card>
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
              onClick={() => setPeriod(month ? shiftMonth(period, -1) : shiftDay(period, -1))}
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
            <button
              type="button"
              onClick={() => {
                setFromMonth(period.slice(0, 7));
                setToMonth(period.slice(0, 7));
                setExporting(true);
              }}
              className="ml-3 flex h-12 shrink-0 items-center gap-2.5 rounded-[10px] border border-line bg-card px-5 text-[17px]"
            >
              导出明细
            </button>
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
      </div>
    </div>
  );
}
