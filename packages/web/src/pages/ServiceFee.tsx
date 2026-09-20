import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { api } from '../api/client';
import { Card } from '../components/Card';
import { Flash } from '../components/Flash';
import { useHotkeys } from '../hooks/useHotkeys';

/** 一个收费项目。价格每次现填，所以带的是「最近常收的几个数」而不是定价 */
interface ServiceItem {
  id: number;
  name: string;
  unit: string;
  /** 已经格式化好的字符串。前端不做金额运算 */
  commonAmounts: string[];
}

interface FeeRow {
  saleId: number;
  time: string;
  name: string;
  amount: string;
  settleType: 'cash' | 'credit';
  customerName: string | null;
  voided: boolean;
}

interface DayFees {
  date: string;
  total: string;
  items: FeeRow[];
}

interface Customer {
  id: number;
  name: string;
}

function today() {
  return new Date().toLocaleDateString('sv-SE');
}

/** "200.00" → "200"，"43.50" 原样留着 —— 按钮上不摆没用的两个零 */
function trimZeros(yuan: string) {
  return yuan.endsWith('.00') ? yuan.slice(0, -3) : yuan;
}

export default function ServiceFee() {
  const qc = useQueryClient();
  const [bizDate, setBizDate] = useState(today);
  const [picked, setPicked] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [settle, setSettle] = useState<'cash' | 'credit'>('cash');
  const [custQuery, setCustQuery] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const services = useQuery({
    queryKey: ['serviceFees'],
    queryFn: () => api.get<{ items: ServiceItem[] }>('/api/services'),
  });
  const day = useQuery({
    queryKey: ['serviceFeeDay', bizDate],
    queryFn: () => api.get<DayFees>(`/api/services/day?date=${bizDate}`),
  });
  // 挂账才需要认人。现金单不挂客户 —— 后端也会拒绝
  const customers = useQuery({
    queryKey: ['customers', custQuery],
    queryFn: () =>
      api.get<{ items: Customer[] }>(
        `/api/customers${custQuery.trim() ? `?q=${encodeURIComponent(custQuery.trim())}` : ''}`,
      ),
    enabled: settle === 'credit',
  });

  const list = services.data?.items ?? [];
  const item = list.find((s) => s.id === picked) ?? list[0];

  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  function refresh() {
    qc.invalidateQueries({ queryKey: ['serviceFeeDay'] });
    qc.invalidateQueries({ queryKey: ['serviceFees'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['debts'] });
  }

  // 收一笔就是开一张销售单 —— 没有第二套写入口径，营业额、毛利、欠款自动跟上
  const record = useMutation({
    mutationFn: () =>
      api.post<{ saleId: number; total: string }>('/api/sales/checkout', {
        bizDate,
        settleType: settle,
        customerId: settle === 'credit' ? customer?.id : undefined,
        items: [{ productId: item!.id, unit: 'base', qty: '1', unitPriceYuan: amount.trim() }],
      }),
    onSuccess: (r) => {
      setFlash({
        tone: 'ok',
        text: settle === 'credit' ? `记在${customer?.name}账上了　¥${r.total}` : `收了 ¥${r.total}`,
      });
      setAmount('');
      refresh();
      amountRef.current?.focus();
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  const undo = useMutation({
    mutationFn: (saleId: number) => api.post<unknown>(`/api/sales/${saleId}/void`, {}),
    onSuccess: () => {
      setFlash({ tone: 'ok', text: '这笔撤了，不再算进收入' });
      refresh();
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  function submit() {
    if (!item) {
      setFlash({ tone: 'bad', text: '还没有收费项目' });
      return;
    }
    if (!amount.trim()) {
      setFlash({ tone: 'bad', text: '填一下收了多少' });
      return;
    }
    if (settle === 'credit' && !customer) {
      setFlash({ tone: 'bad', text: '挂账要选客户 —— 不然这笔钱记在谁头上' });
      return;
    }
    record.mutate();
  }

  useHotkeys({ F8: submit });

  const rows = day.data?.items ?? [];

  return (
    <div className="flex min-h-0 grow flex-col gap-5">
      <div className="flex shrink-0 items-center gap-4">
        <h1 className="m-0 text-2xl font-semibold">桌子费</h1>
        <span className="text-[17px] text-ink-2">
          跟卖货一样算进营业额，只是没有进价 —— 收多少赚多少
        </span>
        <span className="grow" />
        <label className="flex items-center gap-2.5 text-[17px] text-ink-2">
          日期
          <input
            type="date"
            value={bizDate}
            onChange={(e) => setBizDate(e.target.value)}
            aria-label="日期"
            className="num h-12 w-[200px] rounded-[10px] border border-line bg-card px-4 text-[19px]"
          />
        </label>
      </div>

      <div className="flex min-h-0 grow gap-5">
        <Card className="flex grow-[1.45] flex-col overflow-hidden">
          <div className="mb-4 flex shrink-0 items-baseline">
            <span className="mr-3.5 text-[18px] text-ink-2">这天收了</span>
            <span className="num text-[42px] leading-none font-semibold">
              ¥{day.data?.total ?? '0.00'}
            </span>
            <span className="grow" />
            <span className="num text-[17px] text-muted">
              {rows.filter((r) => !r.voided).length} 笔
            </span>
          </div>

          <div className="flex h-12 shrink-0 items-center gap-4 border-t border-line text-[17px] text-ink-2">
            <span className="w-20">时间</span>
            <span className="w-32">项目</span>
            <span className="w-32 text-right">金额</span>
            <span className="grow pl-4">怎么结的</span>
            <span className="w-16" />
          </div>

          <div className="min-h-0 grow overflow-auto">
            {rows.length === 0 && <div className="pt-4 text-[17px] text-muted">这天还没收过</div>}
            {rows.map((r) => (
              <div
                key={r.saleId}
                className={`flex h-16 items-center gap-4 border-t border-line ${
                  r.voided ? 'opacity-55' : ''
                }`}
              >
                <span className="num w-20 text-[17px] text-ink-2">{r.time}</span>
                <span className="w-32 truncate text-[19px]">{r.name}</span>
                <span
                  className={`num w-32 text-right text-[24px] font-medium ${
                    r.voided ? 'line-through' : ''
                  }`}
                >
                  ¥{r.amount}
                </span>
                <span className="grow truncate pl-4 text-[16px] text-ink-2">
                  {r.settleType === 'credit' ? `挂账 · ${r.customerName ?? '—'}` : '现金收讫'}
                </span>
                {/* 撤过的留一行痕迹 —— 凭空消失会让人以为撤错了别的 */}
                {r.voided ? (
                  <span className="w-16 shrink-0 text-center text-[15px] text-muted">已撤</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => undo.mutate(r.saleId)}
                    aria-label={`撤销 ${r.time} 的${r.name} ${r.amount} 元`}
                    className="h-11 w-16 shrink-0 rounded-[10px] text-[17px] text-muted hover:bg-danger-50 hover:text-danger"
                  >
                    撤销
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-4 shrink-0 border-t border-line pt-4 text-[16px] text-muted">
            撤掉的那笔不从库里删，只是不再算进收入 —— 跟卖货单一个规矩
          </div>
        </Card>

        <Card title="收一笔" className="flex min-w-0 grow flex-col overflow-hidden">
          <div className="flex min-h-0 grow flex-col gap-5 overflow-y-auto">
            {/* 只有一个项目就不用选，别让他多点一下 */}
            {list.length > 1 && (
              <div className="shrink-0">
                <div className="mb-2 text-[17px] text-ink-2">收什么</div>
                <div className="flex flex-wrap gap-2.5">
                  {list.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setPicked(s.id)}
                      className={`h-12 rounded-[10px] border px-4 text-[18px] ${
                        item?.id === s.id
                          ? 'border-brand-700 bg-brand-50 text-brand-900'
                          : 'border-line'
                      }`}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 常收的几个价按次数排，不写死 200/300/600 —— 他改价这排按钮就跟着改 */}
            {(item?.commonAmounts.length ?? 0) > 0 && (
              <div className="shrink-0">
                <div className="mb-2 text-[17px] text-ink-2">常收</div>
                <div className="flex flex-wrap gap-2.5">
                  {item?.commonAmounts.map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAmount(trimZeros(a))}
                      className="num h-13 rounded-[10px] border border-line px-5 text-[20px]"
                    >
                      ¥{trimZeros(a)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className="flex shrink-0 flex-col gap-2 text-[17px] text-ink-2">
              收了多少
              <input
                ref={amountRef}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="0.00"
                aria-label="收了多少"
                className="num h-16 w-[240px] rounded-xl border-2 border-line bg-card px-4 text-[30px]"
              />
            </label>

            <div className="shrink-0">
              <div className="mb-2 text-[17px] text-ink-2">怎么结</div>
              <div className="flex gap-2.5">
                {(['cash', 'credit'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setSettle(s);
                      if (s === 'cash') setCustomer(null);
                    }}
                    className={`h-12 rounded-[10px] border px-5 text-[18px] ${
                      settle === s ? 'border-brand-700 bg-brand-50 text-brand-900' : 'border-line'
                    }`}
                  >
                    {s === 'cash' ? '现金收讫' : '记账上'}
                  </button>
                ))}
              </div>
            </div>

            {/* 挂账才出现这一段 —— 现金单不该多出一个选客户的框 */}
            {settle === 'credit' && (
              <div className="shrink-0">
                <div className="mb-2 text-[17px] text-ink-2">
                  记在谁账上
                  {customer && <span className="ml-2 text-brand-900">已选 {customer.name}</span>}
                </div>
                <input
                  value={custQuery}
                  onChange={(e) => setCustQuery(e.target.value)}
                  placeholder="搜名字或拼音"
                  aria-label="记在谁账上"
                  className="h-13 w-full rounded-[10px] border border-line bg-card px-4 text-[19px]"
                />
                <div className="mt-2.5 flex flex-wrap gap-2.5">
                  {(customers.data?.items ?? []).slice(0, 8).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCustomer(c)}
                      className={`h-12 rounded-[10px] border px-4 text-[18px] ${
                        customer?.id === c.id
                          ? 'border-brand-700 bg-brand-50 text-brand-900'
                          : 'border-line'
                      }`}
                    >
                      {c.name}
                    </button>
                  ))}
                  {(customers.data?.items ?? []).length === 0 && (
                    <span className="text-[16px] text-muted">
                      没有这个人。先去「挂账归还」页把他建出来
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <Flash value={flash} className="mt-4 shrink-0" />

          <button
            type="button"
            onClick={submit}
            disabled={record.isPending}
            className="mt-5 flex h-19 shrink-0 items-center justify-center gap-3 rounded-xl bg-brand-700 text-[22px] font-semibold text-white disabled:opacity-60"
          >
            <span className="num text-[14px] font-medium text-[#BFE0D4]">F8</span>
            {record.isPending ? '处理中…' : '收下'}
          </button>
        </Card>
      </div>
    </div>
  );
}
