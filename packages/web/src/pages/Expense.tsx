import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { api } from '../api/client';
import { Card } from '../components/Card';
import { Flash } from '../components/Flash';
import { useHotkeys } from '../hooks/useHotkeys';

interface ExpenseItem {
  id: number;
  bizDate: string;
  category: string;
  /** 已经格式化好的字符串。前端不做金额运算 */
  amount: string;
  note: string;
}

interface MonthExpenses {
  month: string;
  total: string;
  byCategory: { category: string; amount: string; count: number }[];
  items: ExpenseItem[];
}

/** 点一下就填进名目框，但不拦别的写法 —— 拦了「摩托车加油」就会被记成「其他」 */
const QUICK = ['房租', '水电', '伙食', '运费', '人工', '税费', '修理', '其他'];

function thisMonth() {
  return new Date().toLocaleDateString('sv-SE').slice(0, 7);
}

function today() {
  return new Date().toLocaleDateString('sv-SE');
}

/** 月份加减。不拿 Date 做月运算 —— 1 月减一个月要翻年，自己算一次说清楚 */
function shiftMonth(m: string, by: number) {
  const [y, mo] = m.split('-').map(Number);
  const total = y * 12 + (mo - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export default function Expense() {
  const qc = useQueryClient();
  const [month, setMonth] = useState(thisMonth);
  const [bizDate, setBizDate] = useState(today);
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const data = useQuery({
    queryKey: ['expenses', month],
    queryFn: () => api.get<MonthExpenses>(`/api/expenses?month=${month}`),
  });

  function refresh() {
    qc.invalidateQueries({ queryKey: ['expenses'] });
  }

  const record = useMutation({
    mutationFn: () =>
      api.post<{ expenseId: number; month: string; monthTotal: string }>('/api/expenses', {
        bizDate,
        category: category.trim(),
        amountYuan: amount.trim(),
        note: note.trim() || undefined,
      }),
    onSuccess: (r) => {
      setFlash({ tone: 'ok', text: `记下了　${r.month} 共花了 ¥${r.monthTotal}` });
      // 名目留着不清：连着记几笔水电是常事。金额和备注清掉
      setAmount('');
      setNote('');
      // 记到哪个月就把列表翻到哪个月，不然刚记的那笔看不见
      setMonth(r.month);
      refresh();
      amountRef.current?.focus();
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  // 名目和备注不参与任何计算，改错了当场改回来就行 ——
  // 金额和日期错了才走「作废 + 重记」，那两样一改就动合计和归月
  const edit = useMutation({
    mutationFn: (v: { id: number; category?: string; note?: string }) =>
      api.patch<{ expenseId: number }>(`/api/expenses/${v.id}`, {
        category: v.category,
        note: v.note,
      }),
    onSuccess: () => refresh(),
    onError: (e) => {
      setFlash({ tone: 'bad', text: (e as Error).message });
      refresh(); // 拒了就把界面上那个值退回库里的
    },
  });

  const voidOne = useMutation({
    mutationFn: (id: number) => api.post<{ expenseId: number }>(`/api/expenses/${id}/void`, {}),
    onSuccess: () => {
      setFlash({ tone: 'ok', text: '这笔作废了，不再算进合计' });
      refresh();
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  function submit() {
    if (!category.trim()) {
      setFlash({ tone: 'bad', text: '写一下这笔钱花在哪儿' });
      return;
    }
    if (!amount.trim()) {
      setFlash({ tone: 'bad', text: '还没填金额' });
      return;
    }
    record.mutate();
  }

  useHotkeys({ F8: submit });

  const d = data.data;
  const items = d?.items ?? [];

  return (
    <div className="flex min-h-0 grow flex-col gap-5">
      <div className="flex shrink-0 items-center gap-4">
        <span className="text-[17px] text-ink-2">房租水电这些跟商品无关的钱</span>
        <span className="grow" />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            aria-label="上个月"
            className="h-12 w-12 rounded-[10px] border border-line bg-card text-[18px]"
          >
            ‹
          </button>
          <span className="num w-28 text-center text-[20px]">{month}</span>
          <button
            type="button"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            disabled={month >= thisMonth()}
            aria-label="下个月"
            className="h-12 w-12 rounded-[10px] border border-line bg-card text-[18px] disabled:opacity-40"
          >
            ›
          </button>
        </div>
      </div>

      <div className="flex min-h-0 grow gap-5">
        <Card className="flex grow-[1.45] flex-col overflow-hidden">
          <div className="mb-4 flex shrink-0 items-baseline">
            <span className="mr-3.5 text-[18px] text-ink-2">这个月花了</span>
            <span className="num text-[42px] leading-none font-semibold">¥{d?.total ?? '0.00'}</span>
          </div>

          {/* 钱主要去哪儿了 —— 明细一行行看得慢，小计一眼看得完 */}
          {(d?.byCategory.length ?? 0) > 0 && (
            <div className="mb-5 flex shrink-0 flex-wrap gap-2.5">
              {d?.byCategory.map((c) => (
                <span
                  key={c.category}
                  className="flex items-baseline gap-2 rounded-[10px] bg-page px-4 py-2 text-[17px]"
                >
                  {c.category}
                  <span className="num text-[19px] font-medium">¥{c.amount}</span>
                  <span className="num text-[14px] text-muted">{c.count} 笔</span>
                </span>
              ))}
            </div>
          )}

          <div className="flex h-12 shrink-0 items-center gap-4 border-t border-line text-[17px] text-ink-2">
            <span className="w-28">日期</span>
            <span className="w-32 pl-2">名目</span>
            <span className="w-32 text-right">金额</span>
            <span className="grow pl-2">备注　<span className="text-muted">这两格点一下就能改</span></span>
            <span className="w-16" />
          </div>

          <div className="min-h-0 grow overflow-auto">
            {items.length === 0 && (
              <div className="pt-4 text-[17px] text-muted">这个月还没记过开支</div>
            )}
            {items.map((e) => (
              // key 带上值：改完刷新后 defaultValue 才会跟着更新
              <div
                key={`${e.id}-${e.category}-${e.note}`}
                className="flex h-16 items-center gap-4 border-t border-line"
              >
                <span className="num w-28 text-[17px] text-ink-2">{e.bizDate}</span>
                {/* 名目和备注点一下就能改。金额是只读的 —— 它一改就动合计，
                    得留一条作废痕迹，不能悄悄改掉 */}
                <input
                  defaultValue={e.category}
                  onBlur={(ev) => {
                    const v = ev.target.value.trim();
                    if (v && v !== e.category) edit.mutate({ id: e.id, category: v });
                    else ev.target.value = e.category;
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') ev.currentTarget.blur();
                    if (ev.key === 'Escape') {
                      ev.currentTarget.value = e.category;
                      ev.currentTarget.blur();
                    }
                  }}
                  aria-label={`${e.bizDate} 这笔的名目`}
                  className="w-32 rounded-[8px] border border-transparent bg-transparent px-2 py-1 text-[19px] hover:border-line focus:border-brand-700 focus:bg-card"
                />
                <span className="num w-32 text-right text-[24px] font-medium">¥{e.amount}</span>
                <input
                  defaultValue={e.note}
                  onBlur={(ev) => {
                    const v = ev.target.value.trim();
                    if (v !== e.note) edit.mutate({ id: e.id, note: v });
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') ev.currentTarget.blur();
                    if (ev.key === 'Escape') {
                      ev.currentTarget.value = e.note;
                      ev.currentTarget.blur();
                    }
                  }}
                  placeholder="写点什么"
                  aria-label={`${e.bizDate} 这笔的备注`}
                  className="grow rounded-[8px] border border-transparent bg-transparent px-2 py-1 text-[16px] text-ink-2 hover:border-line focus:border-brand-700 focus:bg-card"
                />
                <button
                  type="button"
                  onClick={() => voidOne.mutate(e.id)}
                  aria-label={`作废 ${e.bizDate} 的${e.category}`}
                  className="h-11 w-16 shrink-0 rounded-[10px] text-[17px] text-muted hover:bg-danger-50 hover:text-danger"
                >
                  作废
                </button>
              </div>
            ))}
          </div>

        </Card>

        <Card title="记一笔" className="flex min-w-0 grow flex-col overflow-hidden">
          <div className="flex min-h-0 grow flex-col gap-5 overflow-y-auto">
            <label className="flex shrink-0 flex-col gap-2 text-[17px] text-ink-2">
              哪天花的
              <input
                type="date"
                value={bizDate}
                onChange={(e) => setBizDate(e.target.value)}
                aria-label="哪天花的"
                className="num h-13 w-[200px] rounded-[10px] border border-line bg-card px-4 text-[19px]"
              />
            </label>

            <div className="shrink-0">
              <div className="mb-2 text-[17px] text-ink-2">花在哪儿</div>
              <div className="mb-3 flex flex-wrap gap-2.5">
                {QUICK.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setCategory(q)}
                    className={`h-12 rounded-[10px] border px-4 text-[18px] ${
                      category === q ? 'border-brand-700 bg-brand-50 text-brand-900' : 'border-line'
                    }`}
                  >
                    {q}
                  </button>
                ))}
              </div>
              {/* 点按钮只是把字填进来，照样能自己改 */}
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && amountRef.current?.focus()}
                placeholder="也可以自己写，比如 摩托车加油"
                aria-label="花在哪儿"
                className="h-13 w-full rounded-[10px] border border-line bg-card px-4 text-[19px]"
              />
            </div>

            <label className="flex shrink-0 flex-col gap-2 text-[17px] text-ink-2">
              多少钱
              <input
                ref={amountRef}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="0.00"
                aria-label="多少钱"
                className="num h-14 w-[220px] rounded-[10px] border border-line bg-card px-4 text-[24px]"
              />
            </label>

            <label className="flex shrink-0 flex-col gap-2 text-[17px] text-ink-2">
              备注<span className="text-muted">（选填）</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="比如 交到 10 月底"
                aria-label="备注"
                className="h-13 w-full rounded-[10px] border border-line bg-card px-4 text-[18px]"
              />
            </label>
          </div>

          <Flash value={flash} className="mt-4 shrink-0" />

          <button
            type="button"
            onClick={submit}
            disabled={record.isPending}
            className="mt-5 flex h-19 shrink-0 items-center justify-center gap-3 rounded-xl bg-brand-700 text-[22px] font-semibold text-white disabled:opacity-60"
          >
            <span className="num text-[14px] font-medium text-[#BFE0D4]">F8</span>
            {record.isPending ? '处理中…' : '记下来'}
          </button>
        </Card>
      </div>
    </div>
  );
}
