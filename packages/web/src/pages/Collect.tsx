import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { api, endpoints, exportXlsx } from '../api/client';
import { Card } from '../components/Card';
import { Flash } from '../components/Flash';
import { useHotkeys } from '../hooks/useHotkeys';
import { rowIn } from '../lib/animations';

interface DebtRow {
  customerId: number;
  name: string;
  /** 催账要打的那个号码。没填就是空串 */
  phone: string;
  amount: string;
  earliestUnpaidDate: string | null;
  agingDays: number | null;
}

interface DebtList {
  today: string;
  owing: DebtRow[];
  prepaid: DebtRow[];
  totalOwing: string;
}

interface StatementEntry {
  bizDate: string;
  /** 挂账 / 退货 / 还款 / 当场付 */
  kind: string;
  ref: string;
  /** 带符号：挂账为正、还款为负。已经格式化好，前端不做金额运算 */
  amount: string;
  balance: string;
  note: string;
}

interface Statement {
  name: string;
  phone: string;
  note: string;
  charged: string;
  returned: string;
  paid: string;
  balance: string;
  isPrepaid: boolean;
  entries: StatementEntry[];
}

const METHODS = [
  { key: 'cash', label: '现金' },
  { key: 'wechat', label: '微信' },
  { key: 'alipay', label: '支付宝' },
  { key: 'transfer', label: '转账' },
] as const;

export default function Collect() {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<DebtRow | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<(typeof METHODS)[number]['key']>('cash');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  // 不用 autoFocus：它只在挂载那一刻生效，而这个输入框是条件渲染的，
  // 换个客户再点收款就不会再触发。键盘流里焦点必须是显式控制的。
  useEffect(() => {
    if (picked) {
      amountRef.current?.focus();
      amountRef.current?.select();
    }
  }, [picked]);

  const debts = useQuery({ queryKey: ['debts'], queryFn: () => api.get<DebtList>('/api/customers/debts') });

  // 点开一个客户就把他的往来摊开：挂了多少、还了多少、剩多少。
  // 客户问「我不是还过五百吗」，老板得拿得出东西对
  const statement = useQuery({
    queryKey: ['statement', picked?.customerId],
    queryFn: () => api.get<Statement>(`/api/customers/${picked?.customerId}/statement`),
    enabled: picked != null,
  });

  const collect = useMutation({
    mutationFn: (body: unknown) => endpoints.collect(body),
    onSuccess: (r) => {
      const prepaid = Number(r.netDebt) < 0;
      setFlash({
        tone: 'ok',
        text: prepaid
          ? `收到了。这笔收款用不完，多出来的 ¥${r.netDebt.replace('-', '')} 算预收，下次买货自动抵`
          : `收到了。${picked?.name ?? ''}还欠 ¥${r.netDebt}`,
      });
      setPicked(null);
      setAmount('');
      qc.invalidateQueries({ queryKey: ['debts'] });
      qc.invalidateQueries({ queryKey: ['statement'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  function select(c: DebtRow) {
    setPicked(c);
    setAmount(c.amount);
    setFlash(null);
  }

  function submit() {
    if (!picked) {
      setFlash({ tone: 'bad', text: '先选一个客户' });
      return;
    }
    if (!amount.trim()) {
      setFlash({ tone: 'bad', text: '还没填金额' });
      return;
    }
    collect.mutate({
      bizDate: debts.data?.today ?? new Date().toLocaleDateString('sv-SE'),
      customerId: picked.customerId,
      amountYuan: amount,
      method,
    });
  }

  useHotkeys({
    Escape: () => {
      setPicked(null);
      setAmount('');
    },
  });

  const owing = debts.data?.owing ?? [];
  const prepaid = debts.data?.prepaid ?? [];

  return (
    <div className="flex min-h-0 grow flex-col gap-5">
      <div className="flex shrink-0 items-center gap-4">
        <span className="grow" />
        <button
          type="button"
          onClick={() => void exportXlsx('debts')}
          className="h-12 rounded-[10px] border border-line bg-card px-5 text-[17px]"
        >
          导出欠款表
        </button>
      </div>

      <div className="flex min-h-0 grow gap-5">
        <Card
          title="谁欠我钱"
          extra={<span className="text-[17px] text-ink-2">按账龄倒序</span>}
          className="flex grow-[1.45] flex-col overflow-hidden"
        >
          <div className="mb-3 flex items-baseline">
            <span className="mr-3.5 text-[18px] text-ink-2">合计待收</span>
            <span className="num text-[42px] leading-none font-semibold">
              ¥{debts.data?.totalOwing ?? '0.00'}
            </span>
          </div>

          <div className="flex h-12 items-center gap-4 text-[17px] text-ink-2">
            <span className="w-28">客户</span>
            <span className="w-32">电话</span>
            <span className="w-36 text-right">欠款</span>
            <span className="w-24 text-right">账龄</span>
            <span className="grow" />
          </div>

          <div className="min-h-0 grow overflow-auto">
            {owing.length === 0 && <div className="pt-4 text-[17px] text-muted">没人欠钱</div>}
            {owing.map((c, i) => {
              const on = picked?.customerId === c.customerId;
              const old = (c.agingDays ?? 0) > 30;
              return (
                <motion.div
                  key={c.customerId}
                  {...rowIn(i)}
                  className={`flex h-18 items-center gap-4 border-t border-line ${on ? 'bg-brand-50' : ''}`}
                >
                  {/* 整行可点：右边那个按钮只是把「能点」说出来，
                      老板的手指不会去瞄一个 48px 的按钮 */}
                  <button
                    type="button"
                    onClick={() => select(c)}
                    aria-label={`看${c.name}的往来明细并收款`}
                    className="flex h-18 grow items-center gap-4 rounded-[10px] text-left hover:bg-brand-50"
                  >
                    <span className="w-28 text-[21px]">{c.name}</span>
                    {/* 催账就是打电话。号码不在名字旁边，老板就得另外翻本子 */}
                    <span className="num w-32 text-[17px] text-ink-2">{c.phone || '没留号码'}</span>
                    <span className="num w-36 text-right text-[28px] font-medium">¥{c.amount}</span>
                    {/* 账龄和「最早一笔是哪天」是同一件事的两种说法，
                        这一栏只放能直接决定要不要打电话的那个 —— 天数。
                        具体日期在右边和导出的表里 */}
                    <span className={`num w-24 text-right text-[18px] ${old ? 'text-danger' : 'text-ink-2'}`}>
                      {c.agingDays ?? 0} 天
                    </span>
                    <span className="grow" />
                  </button>
                  <button
                    type="button"
                    onClick={() => select(c)}
                    tabIndex={-1}
                    className={`h-12 shrink-0 rounded-[10px] border px-6 text-[18px] ${
                      on ? 'border-brand-700 text-brand-900' : 'border-line'
                    }`}
                  >
                    收款
                  </button>
                </motion.div>
              );
            })}

            {prepaid.length > 0 && (
              <div className="mt-6 border-t border-line pt-5">
                {/* 预收不进催收队列 —— 混进去这个列表就失去可信度 */}
                <div className="mb-3 text-[17px] text-muted">预收　不进催收队列</div>
                {prepaid.map((c) => (
                  <div key={c.customerId} className="flex h-14 items-center gap-4 text-muted">
                    <span className="w-28 text-[20px]">{c.name}</span>
                    <span className="num w-32 text-[16px]">{c.phone || '没留号码'}</span>
                    <span className="num w-36 text-right text-[21px]">预收 ¥{c.amount}</span>
                    <span className="text-[16px]">下次挂账买货自动抵扣</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card className="flex min-w-0 grow flex-col overflow-hidden">
          {/* 电话跟标题同一行：这一栏竖着的空间要留给明细，不能被抬头吃掉 */}
          <div className="mb-5 flex shrink-0 items-baseline gap-4">
            <h2 className="m-0 text-[19px] font-semibold">
              {picked ? `收${picked.name}的钱` : '收款'}
            </h2>
            {/* 号码取左边那行已经拿到的，不等明细回来 ——
                否则点下去先闪一下「没留号码」，那是假话 */}
            {picked && (
              <span className="num text-[18px] text-ink-2">{picked.phone || '没留号码'}</span>
            )}
            {statement.data?.note && (
              <span className="truncate text-[15px] text-muted">{statement.data.note}</span>
            )}
          </div>

          {!picked && <div className="text-[17px] text-muted">左边点一个客户</div>}

          {/* 中间这一整块滚，确认收款钉在底下 —— 窗口矮的时候
              被挤没的必须是明细的下半截，不能是那个按钮 */}
          {picked && (
            <div className="flex min-h-0 grow flex-col overflow-y-auto">
              <div className="mb-6 shrink-0 rounded-xl bg-page px-5 py-4 text-[19px]">
                共欠 <strong className="num text-[23px] text-danger">¥{picked.amount}</strong>
                {picked.earliestUnpaidDate && (
                  <span className="ml-4 text-[17px] text-ink-2">
                    最早一笔 <span className="num">{picked.earliestUnpaidDate}</span>
                    {picked.agingDays != null && `（${picked.agingDays} 天前）`}
                  </span>
                )}
              </div>

              <label className="flex shrink-0 flex-col gap-2 text-[17px] text-ink-2">
                收到多少
                <input
                  ref={amountRef}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  aria-label="收到多少"
                  className="num h-13 w-52 rounded-[10px] border border-line bg-card px-4 text-[21px]"
                />
              </label>

              <div className="mt-6 shrink-0">
                <div className="mb-3 text-[17px] text-ink-2">怎么收的</div>
                <div className="flex gap-2.5">
                  {METHODS.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setMethod(m.key)}
                      className={`h-13 rounded-[10px] border px-5 text-[18px] ${
                        method === m.key ? 'border-brand-700 bg-brand-50 text-brand-900' : 'border-line'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 一个滚动区就够：明细整条铺开，跟上面的表单一起滚。
                  两层滚动条老板分不清在滚哪一个 */}
              <div className="mt-6 shrink-0">
                <div className="mb-2.5 flex items-baseline gap-3">
                  <span className="text-[17px] text-ink-2">往来明细</span>
                  <span className="num text-[15px] text-muted">
                    挂账 ¥{statement.data?.charged ?? '0.00'}　已还 ¥{statement.data?.paid ?? '0.00'}
                    {statement.data && statement.data.returned !== '0.00' &&
                      `　退货 ¥${statement.data.returned}`}
                  </span>
                </div>

                <div className="overflow-hidden rounded-xl border border-line">
                  {(statement.data?.entries.length ?? 0) === 0 && (
                    <div className="px-4 py-3 text-[16px] text-muted">
                      {statement.isPending ? '读取中…' : '这个客户还没有往来记录'}
                    </div>
                  )}
                  {/* 最近的排最上面：先看见「现在欠多少」，
                      往下翻才是这笔账怎么攒起来的 */}
                  {[...(statement.data?.entries ?? [])].reverse().map((e, i) => {
                    const back = e.amount.startsWith('-');
                    return (
                      <div
                        key={`${e.bizDate}-${e.ref}-${i}`}
                        className="flex h-12 items-center gap-3 border-b border-line px-4 last:border-b-0"
                      >
                        <span className="num w-24 text-[15px] text-ink-2">{e.bizDate}</span>
                        <span className={`w-16 text-[16px] ${back ? 'text-brand-900' : ''}`}>
                          {e.kind}
                        </span>
                        <span className="grow" />
                        <span
                          className={`num w-28 text-right text-[18px] font-medium ${
                            back ? 'text-brand-900' : ''
                          }`}
                        >
                          {back ? `−¥${e.amount.slice(1)}` : `¥${e.amount}`}
                        </span>
                        <span className="num w-28 text-right text-[15px] text-muted">
                          余 ¥{e.balance}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <Flash value={flash} className="mt-5 shrink-0" />

          {/* 最近的排在最上面：一屏之内先看见「现在欠多少」，
              往下翻才是这笔账怎么攒起来的 */}
          {!picked && <div className="grow" />}

          <div className="mt-5 flex shrink-0 flex-col gap-3">
            <button
              type="button"
              onClick={submit}
              disabled={!picked || collect.isPending}
              className="flex h-19 items-center justify-center gap-3 rounded-xl bg-brand-700 text-[22px] font-semibold text-white disabled:opacity-40"
            >
              <span className="num text-[14px] font-medium text-[#BFE0D4]">Enter</span>
              {collect.isPending ? '处理中…' : '确认收款'}
            </button>
            <div className="text-center text-[15px] leading-relaxed text-muted">
              系统从最早一笔开始自动核销，不用你选哪张单
              <br />
              收多了也照收，多出来的算预收
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
