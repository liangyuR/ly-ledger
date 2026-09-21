import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api, exportXlsx } from '../api/client';
import { Card, Figure } from '../components/Card';

interface IncomeItem {
  id: number;
  bizDate: string;
  /** "卖货" | "桌子费" */
  category: string;
  name: string;
  amount: string;
}

interface ExpenseItem {
  id: number;
  bizDate: string;
  category: string;
  amount: string;
  note: string;
}

interface CollectedItem {
  id: number;
  bizDate: string;
  customerName: string;
  amount: string;
  method: 'cash' | 'wechat' | 'alipay' | 'transfer';
  note: string;
}

interface NewCreditItem {
  saleId: number;
  bizDate: string;
  customerName: string;
  summary: string;
  amount: string;
}

interface CategoryTotal {
  category: string;
  amount: string;
  amountCents: number;
  count: number;
}

interface IncomeExpenseSummary {
  month: string;
  /** 已经格式化好的字符串。前端不做金额运算 */
  cashSales: string;
  creditCollected: string;
  totalIncome: string;
  newCredit: string;
  expenseTotal: string;
  net: string;
  incomeByCategory: CategoryTotal[];
  incomeItems: IncomeItem[];
  newCreditItems: NewCreditItem[];
  expenseByCategory: CategoryTotal[];
  expenseItems: ExpenseItem[];
  collectedItems: CollectedItem[];
}

/* 一路深绿到浅绿的色阶 —— 整套界面就墨绿一个主色，饼图分类靠深浅区分，
   不额外引入彩虹色（红只留给真异常，见 styles/index.css 的说明） */
const SLICE_COLORS = [
  '#12604d',
  '#1a8870',
  '#4fa892',
  '#7ec1af',
  '#a9d6c9',
  '#c9e5db',
];

/**
 * 圆环图。饼图对占比没意义（切太细看不出角度差），这里改用甜甜圈：
 * 中间空出来放合计，外圈的粗细一眼就能比。
 *
 * 点一下某个类目，圆环和下面「明细」表联动筛出那一类 —— 光好看没用，
 * 得帮着回答「桌子费到底是哪几笔」这种问题，再点一下取消
 */
function DonutChart({
  data,
  total,
  selected,
  onSelect,
}: {
  data: CategoryTotal[];
  total: string;
  selected: string | null;
  onSelect: (category: string | null) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const R = 62;
  const STROKE = 26;
  const HOVER_STROKE = 31;
  const C = 2 * Math.PI * R;
  const sumCents = data.reduce((s, d) => s + d.amountCents, 0);
  const active = hover ?? selected;
  const activeRow = data.find((d) => d.category === active);

  // 悬停时圆环加粗到 31px，半径 + 半个描边宽度必须留在画布内 ——
  // 之前按普通描边宽度算画布，悬停一放大就把圆环顶到 viewBox 外面被裁掉
  const SIZE = 2 * (R + HOVER_STROKE / 2 + 4);
  const CENTER = SIZE / 2;

  let offset = 0;
  return (
    <div className="flex items-center gap-6">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="shrink-0"
        onMouseLeave={() => setHover(null)}
      >
        <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
          {sumCents <= 0 ? (
            <circle cx={CENTER} cy={CENTER} r={R} fill="none" stroke="var(--color-line)" strokeWidth={STROKE} />
          ) : (
            data.map((d, i) => {
              const frac = d.amountCents / sumCents;
              const len = frac * C;
              // 缝之间留一点白边，切片挨得太紧分不清界限
              const gap = data.length > 1 ? 2 : 0;
              const isActive = active === d.category;
              const dimmed = active !== null && !isActive;
              const el = (
                <circle
                  key={d.category}
                  cx={CENTER}
                  cy={CENTER}
                  r={R}
                  fill="none"
                  stroke={SLICE_COLORS[i % SLICE_COLORS.length]}
                  strokeWidth={isActive ? HOVER_STROKE : STROKE}
                  strokeOpacity={dimmed ? 0.35 : 1}
                  strokeDasharray={`${Math.max(len - gap, 0)} ${C - len + gap}`}
                  strokeDashoffset={-offset}
                  onMouseEnter={() => setHover(d.category)}
                  onClick={() => onSelect(selected === d.category ? null : d.category)}
                  className="cursor-pointer transition-[stroke-width,stroke-opacity] duration-150 ease-out"
                />
              );
              offset += len;
              return el;
            })
          )}
        </g>
        <text
          x={CENTER}
          y={CENTER - 4}
          textAnchor="middle"
          className="num"
          style={{ fontSize: 13, fill: 'var(--color-ink-2)' }}
        >
          {activeRow ? activeRow.category : '合计'}
        </text>
        <text
          x={CENTER}
          y={CENTER + 16}
          textAnchor="middle"
          className="num"
          style={{ fontSize: 17, fontWeight: 600, fill: 'var(--color-ink)' }}
        >
          ¥{activeRow ? activeRow.amount : total}
        </text>
      </svg>

      <div className="flex flex-col gap-1">
        {data.length === 0 && <span className="text-[16px] text-muted">这个月还没有数据</span>}
        {data.map((d, i) => {
          const isActive = active === d.category;
          const dimmed = active !== null && !isActive;
          return (
            <button
              key={d.category}
              type="button"
              onMouseEnter={() => setHover(d.category)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect(selected === d.category ? null : d.category)}
              aria-pressed={selected === d.category}
              className={`flex items-baseline gap-2.5 rounded-[8px] px-2 py-1 text-[16px] transition-opacity duration-150 ${
                selected === d.category ? 'bg-brand-50' : ''
              } ${dimmed ? 'opacity-45' : ''}`}
            >
              <span
                className="inline-block size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: SLICE_COLORS[i % SLICE_COLORS.length] }}
              />
              <span className="w-16 text-left text-ink-2">{d.category}</span>
              <span className="num font-medium">¥{d.amount}</span>
              <span className="num text-[13px] text-muted">
                {sumCents > 0 ? Math.round((d.amountCents / sumCents) * 100) : 0}%
              </span>
            </button>
          );
        })}
        {selected && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="mt-1 self-start text-[14px] text-muted underline decoration-dotted underline-offset-4 hover:text-brand-900"
          >
            清除筛选
          </button>
        )}
      </div>
    </div>
  );
}

const METHOD_LABEL: Record<CollectedItem['method'], string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  transfer: '转账',
};

function thisMonth() {
  return new Date().toLocaleDateString('sv-SE').slice(0, 7);
}

/** 月份加减。不拿 Date 做月运算 —— 1 月减一个月要翻年，自己算一次说清楚 */
function shiftMonth(m: string, by: number) {
  const [y, mo] = m.split('-').map(Number);
  const total = y * 12 + (mo - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export default function IncomeExpense() {
  const [month, setMonth] = useState(thisMonth);
  // 点圆环筛出那一类，换月份就该清空 —— 上个月点的「桌子费」不该套在这个月头上
  const [incomeFilter, setIncomeFilter] = useState<string | null>(null);
  const [expenseFilter, setExpenseFilter] = useState<string | null>(null);

  const { data: d } = useQuery({
    queryKey: ['incomeExpense', month],
    queryFn: () => api.get<IncomeExpenseSummary>(`/api/income-expense?month=${month}`),
  });

  const netNegative = (d?.net ?? '0').startsWith('-');
  const incomeItems = d?.incomeItems.filter((i) => !incomeFilter || i.category === incomeFilter) ?? [];
  const expenseItems = d?.expenseItems.filter((e) => !expenseFilter || e.category === expenseFilter) ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex shrink-0 items-stretch gap-5">
        <div className="flex flex-1 items-stretch gap-5">
          <div className="flex-1">
            <Figure label="现金收入" value={`¥${d?.cashSales ?? '0.00'}`} tone="brand" sub="卖货、桌子费收现" />
          </div>
          <div className="flex-1">
            <Figure label="挂账收回" value={`¥${d?.creditCollected ?? '0.00'}`} tone="brand" sub="别人还的钱" />
          </div>
          <div className="flex-1">
            <Figure label="开支" value={`¥${d?.expenseTotal ?? '0.00'}`} tone="danger" sub="这个月花掉的" />
          </div>
          <div className="flex-1">
            <Figure
              label="净结余"
              value={`¥${d?.net ?? '0.00'}`}
              tone={netNegative ? 'danger' : 'brand'}
              sub="现金收入 + 挂账收回 − 开支"
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setMonth((m) => shiftMonth(m, -1));
              setIncomeFilter(null);
              setExpenseFilter(null);
            }}
            aria-label="上个月"
            className="h-12 w-12 rounded-[10px] border border-line bg-card text-[18px]"
          >
            ‹
          </button>
          <span className="num w-28 text-center text-[20px]">{month}</span>
          <button
            type="button"
            onClick={() => {
              setMonth((m) => shiftMonth(m, 1));
              setIncomeFilter(null);
              setExpenseFilter(null);
            }}
            disabled={month >= thisMonth()}
            aria-label="下个月"
            className="h-12 w-12 rounded-[10px] border border-line bg-card text-[18px] disabled:opacity-40"
          >
            ›
          </button>
          <button
            type="button"
            onClick={() => void exportXlsx('income_expense', { month })}
            className="ml-1 flex h-12 items-center gap-2.5 rounded-[10px] border border-line bg-card px-5 text-[17px]"
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
            导出 Excel
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-5">
        <Card title="收入构成" className="min-w-[340px] flex-1">
          <DonutChart
            data={d?.incomeByCategory ?? []}
            total={d?.cashSales ?? '0.00'}
            selected={incomeFilter}
            onSelect={setIncomeFilter}
          />
        </Card>
        <Card title="支出构成" className="min-w-[340px] flex-1">
          <DonutChart
            data={d?.expenseByCategory ?? []}
            total={d?.expenseTotal ?? '0.00'}
            selected={expenseFilter}
            onSelect={setExpenseFilter}
          />
        </Card>
      </div>

      {/* 横版三行：每张卡占满宽度，不挤成窄列 —— 单子多了整页往下拉，不挤在一屏里各卷各的 */}
      <div className="flex flex-col gap-5">
        <Card
          title="收入明细"
          className="w-full"
          extra={
            incomeFilter && (
              <span className="flex items-center gap-2 text-[15px] font-normal text-brand-900">
                只看「{incomeFilter}」
                <button
                  type="button"
                  onClick={() => setIncomeFilter(null)}
                  aria-label="清除收入筛选"
                  className="text-muted hover:text-brand-900"
                >
                  ×
                </button>
              </span>
            )
          }
        >
          {(d?.incomeByCategory.length ?? 0) > 0 && (
            <div className="mb-4 flex flex-wrap gap-2.5">
              {d?.incomeByCategory.map((c) => (
                <button
                  key={c.category}
                  type="button"
                  onClick={() => setIncomeFilter(incomeFilter === c.category ? null : c.category)}
                  className={`flex items-baseline gap-2 rounded-[10px] px-4 py-2 text-[16px] transition-colors ${
                    incomeFilter === c.category ? 'bg-brand-50 text-brand-900' : 'bg-page'
                  }`}
                >
                  {c.category}
                  <span className="num text-[18px] font-medium">¥{c.amount}</span>
                  <span className="num text-[13px] text-muted">{c.count} 笔</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex h-11 items-center gap-4 border-t border-line text-[16px] text-ink-2">
            <span className="w-24">日期</span>
            <span className="w-20">类目</span>
            <span className="grow">项目</span>
            <span className="w-24 text-right">金额</span>
          </div>

          {incomeItems.length === 0 && (
            <div className="pt-4 text-[16px] text-muted">
              {incomeFilter ? '这一类这个月没有收入' : '这个月还没收过现金'}
            </div>
          )}
          {incomeItems.map((i) => (
            <div key={i.id} className="flex h-14 items-center gap-4 border-t border-line">
              <span className="num w-24 text-[16px] text-ink-2">{i.bizDate}</span>
              <span className="w-20 truncate text-[15px] text-ink-2">{i.category}</span>
              <span className="grow truncate text-[17px]">{i.name}</span>
              <span className="num w-24 shrink-0 text-right text-[20px] font-medium">¥{i.amount}</span>
            </div>
          ))}
        </Card>

        <Card
          title="支出明细"
          className="w-full"
          extra={
            expenseFilter && (
              <span className="flex items-center gap-2 text-[15px] font-normal text-brand-900">
                只看「{expenseFilter}」
                <button
                  type="button"
                  onClick={() => setExpenseFilter(null)}
                  aria-label="清除支出筛选"
                  className="text-muted hover:text-brand-900"
                >
                  ×
                </button>
              </span>
            )
          }
        >
          {(d?.expenseByCategory.length ?? 0) > 0 && (
            <div className="mb-4 flex flex-wrap gap-2.5">
              {d?.expenseByCategory.map((c) => (
                <button
                  key={c.category}
                  type="button"
                  onClick={() => setExpenseFilter(expenseFilter === c.category ? null : c.category)}
                  className={`flex items-baseline gap-2 rounded-[10px] px-4 py-2 text-[16px] transition-colors ${
                    expenseFilter === c.category ? 'bg-brand-50 text-brand-900' : 'bg-page'
                  }`}
                >
                  {c.category}
                  <span className="num text-[18px] font-medium">¥{c.amount}</span>
                  <span className="num text-[13px] text-muted">{c.count} 笔</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex h-11 items-center gap-4 border-t border-line text-[16px] text-ink-2">
            <span className="w-24">日期</span>
            <span className="w-28">名目</span>
            <span className="grow text-right">金额</span>
          </div>

          {expenseItems.length === 0 && (
            <div className="pt-4 text-[16px] text-muted">
              {expenseFilter ? '这一类这个月没有开支' : '这个月还没记过开支'}
            </div>
          )}
          {expenseItems.map((e) => (
            <div key={e.id} className="flex h-14 items-center gap-4 border-t border-line">
              <span className="num w-24 text-[16px] text-ink-2">{e.bizDate}</span>
              <span className="w-28 truncate text-[17px]">{e.category}</span>
              <span className="grow truncate text-right text-[15px] text-ink-2">{e.note}</span>
              <span className="num w-28 shrink-0 text-right text-[20px] font-medium">¥{e.amount}</span>
            </div>
          ))}
        </Card>

        <Card
          title="挂账明细"
          className="w-full"
          extra={<span className="text-[15px] font-normal text-muted">记着但还没收到钱，不算进上面的收入</span>}
        >
          <div className="flex h-11 items-center gap-4 border-t border-line text-[16px] text-ink-2">
            <span className="w-24">日期</span>
            <span className="w-20">挂谁账上</span>
            <span className="grow">项目</span>
            <span className="w-24 text-right">金额</span>
          </div>

          {(d?.newCreditItems.length ?? 0) === 0 && (
            <div className="pt-4 text-[16px] text-muted">这个月还没新挂过账</div>
          )}
          {d?.newCreditItems.map((c) => (
            <div key={c.saleId} className="flex h-14 items-center gap-4 border-t border-line">
              <span className="num w-24 text-[16px] text-ink-2">{c.bizDate}</span>
              <span className="w-20 truncate text-[15px] text-ink-2">{c.customerName}</span>
              <span className="grow truncate text-[17px]">{c.summary}</span>
              <span className="num w-24 shrink-0 text-right text-[20px] font-medium">¥{c.amount}</span>
            </div>
          ))}
        </Card>

        <Card title="挂账收回明细" className="w-full">
          <div className="flex h-11 items-center gap-4 border-t border-line text-[16px] text-ink-2">
            <span className="w-24">日期</span>
            <span className="w-28">谁还的</span>
            <span className="grow text-right">金额</span>
          </div>

          {(d?.collectedItems.length ?? 0) === 0 && (
            <div className="pt-4 text-[16px] text-muted">这个月还没收过挂账</div>
          )}
          {d?.collectedItems.map((c) => (
            <div key={c.id} className="flex h-14 items-center gap-4 border-t border-line">
              <span className="num w-24 text-[16px] text-ink-2">{c.bizDate}</span>
              <span className="w-28 truncate text-[17px]">{c.customerName}</span>
              <span className="grow truncate text-right text-[15px] text-ink-2">
                {METHOD_LABEL[c.method]}
                {c.note && `　·　${c.note}`}
              </span>
              <span className="num w-28 shrink-0 text-right text-[20px] font-medium">¥{c.amount}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
