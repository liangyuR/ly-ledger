import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, endpoints, type Product } from '../api/client';
import { Card } from '../components/Card';
import { Flash } from '../components/Flash';
import { useHotkeys } from '../hooks/useHotkeys';
import { formatYuan, lineAmountCents, yuanToCents } from '../money';

interface DetailItem {
  productId: number;
  name: string;
  qty: string;
  unit: 'base' | 'pack';
  unitLabel: string;
  unitPrice: string;
  amount: string;
  unitCost: string;
  cost: string;
  profit: string;
}

interface SaleEvent {
  kind: 'created' | 'revised' | 'returned' | 'voided';
  saleId: number;
  time: string;
  date: string;
  rev: number;
  summary: string;
  current: boolean;
}

interface Detail {
  id: number;
  bizDate: string;
  settleType: 'cash' | 'credit';
  customerId: number | null;
  customerName: string | null;
  original: string;
  discount: string;
  total: string;
  cost: string;
  profit: string;
  returned: string;
  settled: string;
  rev: number;
  voidedAt: string | null;
  voidReason: string | null;
  items: DetailItem[];
  events: SaleEvent[];
  canRevise: boolean;
  canReturn: boolean;
  blockedReason: string | null;
}

interface EditLine {
  key: string;
  productId: number;
  name: string;
  unit: 'base' | 'pack';
  unitLabel: string;
  qty: string;
  unitPrice: string;
}

const EVENT_LABEL: Record<SaleEvent['kind'], string> = {
  created: '录入',
  revised: '改为',
  returned: '退货',
  // 不说"作废"——老板的说法是"这笔没发生过"
  voided: '撤掉',
};

export default function SaleDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const saleId = Number(id);

  const [mode, setMode] = useState<'view' | 'edit' | 'return'>('view');
  const [lines, setLines] = useState<EditLine[]>([]);
  const [discount, setDiscount] = useState('0');
  const [returnDate, setReturnDate] = useState(() => new Date().toLocaleDateString('sv-SE'));
  const [returnQty, setReturnQty] = useState<Record<number, string>>({});
  const [addQuery, setAddQuery] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const detail = useQuery({
    queryKey: ['sale', saleId],
    queryFn: () => api.get<Detail>(`/api/sales/${saleId}`),
    enabled: Number.isFinite(saleId),
  });

  const search = useQuery({
    queryKey: ['products', addQuery],
    queryFn: () => endpoints.products(addQuery),
    enabled: mode === 'edit' && addQuery.trim().length > 0,
  });

  const d = detail.data;

  // 进编辑态时把当前明细搬进可编辑的草稿
  useEffect(() => {
    if (mode === 'edit' && d) {
      setLines(
        d.items.map((i, n) => ({
          key: `${i.productId}-${n}`,
          productId: i.productId,
          name: i.name,
          unit: i.unit,
          unitLabel: i.unitLabel,
          qty: i.qty,
          unitPrice: i.unitPrice,
        })),
      );
      setDiscount(d.discount);
    }
  }, [mode, d]);

  const previewCents = lines.reduce((s, l) => {
    try {
      return s + lineAmountCents(l.qty, yuanToCents(l.unitPrice));
    } catch {
      return s;
    }
  }, 0);
  const discountPreview = (() => {
    try {
      return discount.trim() ? yuanToCents(discount) : 0;
    } catch {
      return 0;
    }
  })();

  const revise = useMutation({
    mutationFn: () =>
      api.post<{ saleId: number; rev: number; total: string; grossProfit: string }>(
        `/api/sales/${saleId}/revise`,
        {
          bizDate: d?.bizDate,
          settleType: d?.settleType,
          // 挂账单必须带上客户，否则后端会按"挂账必须指定客户"拒绝
          customerId: d?.settleType === 'credit' ? d.customerId : undefined,
          discountYuan: discount || '0',
          items: lines.map((l) => ({
            productId: l.productId,
            unit: l.unit,
            qty: l.qty,
            unitPriceYuan: l.unitPrice,
          })),
        },
      ),
    onSuccess: (r) => {
      setMode('view');
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      // 改单会建一张新单，要跳到新的那张去
      navigate(`/sales/${r.saleId}`, { replace: true });
      setFlash({ tone: 'ok', text: `改好了　应收 ¥${r.total}　毛利 ¥${r.grossProfit}` });
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  const doReturn = useMutation({
    mutationFn: () => {
      const picked = Object.entries(returnQty)
        .filter(([, q]) => q.trim() && Number(q) > 0)
        .map(([pid, q]) => ({ productId: Number(pid), qty: q }));
      return api.post<{ returnSaleId: number; refund: string }>(`/api/sales/${saleId}/return`, {
        bizDate: returnDate,
        items: picked.length ? picked : undefined,
      });
    },
    onSuccess: (r) => {
      setMode('view');
      setReturnQty({});
      qc.invalidateQueries({ queryKey: ['sale', saleId] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setFlash({ tone: 'ok', text: `退了 ¥${r.refund}，记在 ${returnDate}` });
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  useHotkeys({
    Escape: () => (mode === 'view' ? navigate(-1) : setMode('view')),
  });

  if (detail.isError) {
    return (
      <Card title="打不开这张单">
        <p className="m-0 text-[19px] text-danger">{(detail.error as Error).message}</p>
      </Card>
    );
  }
  if (!d) return <Card title="加载中">…</Card>;

  return (
    <div className="flex min-h-0 grow flex-col gap-5">
      <div className="flex shrink-0 items-center gap-4">
        <button type="button" onClick={() => navigate(-1)} className="text-[19px] text-ink-2">
          ←
        </button>
        <h1 className="m-0 text-2xl font-semibold">单据详情</h1>
        <span className="num text-[17px] text-ink-2">
          #{d.id}　{d.bizDate}　{d.settleType === 'cash' ? '现金' : `挂账 · ${d.customerName ?? ''}`}
          {d.rev > 1 && `　第 ${d.rev} 版`}
        </span>
        <span className="grow" />
        {/* 改单产生的旧版本对老板来说就是"旧版本"，不是"作废" ——
            界面上不出现会计词汇（docs/04 原则 6） */}
        {d.voidedAt && d.voidReason === 'revised' && (
          <span className="rounded-lg bg-page px-4 py-2 text-[17px] text-ink-2">
            旧版本，已被后来的改动取代
          </span>
        )}
        {d.voidedAt && d.voidReason !== 'revised' && (
          <span className="rounded-lg bg-danger-50 px-4 py-2 text-[17px] text-danger">
            这笔生意没发生过
          </span>
        )}
      </div>

      <Flash value={flash} className="shrink-0" />

      <div className="flex min-h-0 grow gap-5">
        <Card className="flex min-w-0 grow flex-col">
          {/* ── 明细 ── */}
          <div className="flex h-12 shrink-0 items-center gap-4 text-[17px] text-ink-2">
            <span className="grow">商品</span>
            <span className="w-20 text-right">数量</span>
            <span className="w-24 text-right">单价</span>
            <span className="w-28 text-right">小计</span>
            {mode === 'view' && <span className="w-28 text-right">成本快照</span>}
            {mode === 'view' && <span className="w-24 text-right">毛利</span>}
            {mode !== 'view' && <span className="w-24 text-right">操作</span>}
          </div>

          <div className="min-h-0 grow overflow-auto">
            {mode === 'view' &&
              d.items.map((i, n) => (
                <div key={n} className="flex h-15 items-center gap-4 border-t border-line text-[19px]">
                  <span className="grow">{i.name}</span>
                  <span className="num w-20 text-right text-ink-2">
                    {i.qty} {i.unitLabel}
                  </span>
                  <span className="num w-24 text-right">¥{i.unitPrice}</span>
                  <span className="num w-28 text-right">¥{i.amount}</span>
                  <span className="num w-28 text-right text-ink-2">¥{i.unitCost}</span>
                  <span className="num w-24 text-right text-brand-900">¥{i.profit}</span>
                </div>
              ))}

            {mode === 'edit' &&
              lines.map((l, n) => (
                <div key={l.key} className="flex h-16 items-center gap-4 border-t border-line text-[19px]">
                  <span className="grow">{l.name}</span>
                  <input
                    value={l.qty}
                    onChange={(e) =>
                      setLines((p) => p.map((x, i) => (i === n ? { ...x, qty: e.target.value } : x)))
                    }
                    aria-label={`${l.name} 数量`}
                    className="num h-11 w-20 rounded-lg border border-line px-2 text-right"
                  />
                  <span className="w-8 text-[16px] text-ink-2">{l.unitLabel}</span>
                  <input
                    value={l.unitPrice}
                    onChange={(e) =>
                      setLines((p) => p.map((x, i) => (i === n ? { ...x, unitPrice: e.target.value } : x)))
                    }
                    aria-label={`${l.name} 单价`}
                    className="num h-11 w-24 rounded-lg border border-line px-2 text-right"
                  />
                  <span className="num w-28 text-right text-ink-2">
                    ¥
                    {(() => {
                      try {
                        return formatYuan(lineAmountCents(l.qty, yuanToCents(l.unitPrice)));
                      } catch {
                        return '—';
                      }
                    })()}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLines((p) => p.filter((_, i) => i !== n))}
                    className="w-24 text-right text-[16px] text-muted hover:text-danger"
                  >
                    删掉
                  </button>
                </div>
              ))}

            {mode === 'return' &&
              d.items.map((i, n) => (
                <div key={n} className="flex h-16 items-center gap-4 border-t border-line text-[19px]">
                  <span className="grow">{i.name}</span>
                  <span className="num w-28 text-right text-ink-2">
                    原 {i.qty} {i.unitLabel}
                  </span>
                  <input
                    value={returnQty[i.productId] ?? ''}
                    onChange={(e) => setReturnQty((p) => ({ ...p, [i.productId]: e.target.value }))}
                    placeholder="退多少"
                    aria-label={`${i.name} 退货数量`}
                    className="num h-11 w-28 rounded-lg border border-line px-2 text-right"
                  />
                  <span className="w-24 text-[16px] text-ink-2">{i.unitLabel}</span>
                </div>
              ))}
          </div>

          {/* ── 编辑态：加一个商品 ── */}
          {mode === 'edit' && (
            <div className="mt-3 shrink-0 border-t border-line pt-3">
              <input
                value={addQuery}
                onChange={(e) => setAddQuery(e.target.value)}
                placeholder="要加商品？搜一下拼音"
                aria-label="加商品"
                className="h-12 w-full rounded-[10px] border border-line px-4 text-[18px]"
              />
              {addQuery.trim() && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {(search.data?.items ?? []).slice(0, 5).map((p: Product) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        const usePack = !!p.pack_unit && p.price_pack_cents != null;
                        setLines((prev) => [
                          ...prev,
                          {
                            key: `${p.id}-new-${Date.now()}`,
                            productId: p.id,
                            name: p.name,
                            unit: usePack ? 'pack' : 'base',
                            unitLabel: usePack ? (p.pack_unit ?? p.base_unit) : p.base_unit,
                            qty: '1',
                            unitPrice: String(
                              ((usePack ? p.price_pack_cents : p.price_base_cents) ?? 0) / 100,
                            ),
                          },
                        ]);
                        setAddQuery('');
                      }}
                      className="h-11 rounded-[10px] border border-line px-4 text-[17px]"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── 合计 ── */}
          <div className="mt-4 flex shrink-0 flex-col gap-3 border-t-2 border-line pt-4 text-[19px]">
            {mode === 'view' ? (
              <>
                <Row label="折前" value={`¥${d.original}`} muted />
                {d.discount !== '0.00' && <Row label="抹零" value={`−¥${d.discount}`} danger />}
                {d.returned !== '0.00' && <Row label="已退" value={`¥${d.returned}`} danger />}
                {d.settleType === 'credit' && <Row label="已收" value={`¥${d.settled}`} muted />}
                <div className="flex items-baseline">
                  <span className="grow font-semibold">应收</span>
                  <span className="num text-[38px] font-semibold text-brand-900">¥{d.total}</span>
                </div>
                <Row label="毛利" value={`¥${d.profit}`} />
              </>
            ) : mode === 'edit' ? (
              <>
                <Row label="折前" value={`¥${formatYuan(previewCents)}`} muted />
                <div className="flex items-center gap-3.5">
                  <label htmlFor="d" className="grow text-ink-2">
                    抹零
                  </label>
                  <input
                    id="d"
                    value={discount}
                    onChange={(e) => setDiscount(e.target.value)}
                    className="num h-11 w-28 rounded-lg border border-line px-2 text-right"
                  />
                </div>
                <div className="flex items-baseline">
                  <span className="grow font-semibold">应收</span>
                  <span className="num text-[38px] font-semibold text-brand-900">
                    ¥{formatYuan(previewCents - discountPreview)}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3.5">
                <label htmlFor="rd" className="text-ink-2">
                  退货日期
                </label>
                <input
                  id="rd"
                  type="date"
                  value={returnDate}
                  onChange={(e) => setReturnDate(e.target.value)}
                  className="num h-11 w-48 rounded-lg border border-line px-3"
                />
                <span className="text-[16px] text-muted">
                  不填数量 = 整单退。冲减记在这一天，不动原单那天的营业额
                </span>
              </div>
            )}
          </div>

          {/* ── 操作 ── */}
          <div className="mt-5 flex shrink-0 gap-3.5">
            {mode === 'view' && (
              <>
                <button
                  type="button"
                  disabled={!d.canRevise}
                  onClick={() => setMode('edit')}
                  className="h-15 grow rounded-xl bg-brand-700 text-[19px] font-semibold text-white disabled:opacity-40"
                >
                  改这张单
                </button>
                <button
                  type="button"
                  disabled={!d.canReturn}
                  onClick={() => setMode('return')}
                  className="h-15 grow rounded-xl border border-[#EBC9C6] bg-danger-50 text-[19px] font-semibold text-danger disabled:opacity-40"
                >
                  退货
                </button>
              </>
            )}
            {mode === 'edit' && (
              <>
                <button
                  type="button"
                  onClick={() => revise.mutate()}
                  disabled={revise.isPending || lines.length === 0}
                  className="h-15 grow rounded-xl bg-brand-700 text-[19px] font-semibold text-white disabled:opacity-40"
                >
                  {revise.isPending ? '保存中…' : '保存'}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('view')}
                  className="h-15 w-40 rounded-xl border border-line text-[19px]"
                >
                  算了
                </button>
              </>
            )}
            {mode === 'return' && (
              <>
                <button
                  type="button"
                  onClick={() => doReturn.mutate()}
                  disabled={doReturn.isPending}
                  className="h-15 grow rounded-xl bg-danger text-[19px] font-semibold text-white disabled:opacity-40"
                >
                  {doReturn.isPending ? '处理中…' : '确认退货'}
                </button>
                <button
                  type="button"
                  onClick={() => setMode('view')}
                  className="h-15 w-40 rounded-xl border border-line text-[19px]"
                >
                  算了
                </button>
              </>
            )}
          </div>

          {d.blockedReason && (
            <div className="mt-3 shrink-0 text-[16px] text-muted">{d.blockedReason}</div>
          )}

          <div className="mt-3 shrink-0 text-[15px] leading-relaxed text-muted">
            <strong className="font-semibold text-ink-2">改这张单</strong>
            是"当时就录错了"，改完就像没错过。
            <strong className="font-semibold text-ink-2">退货</strong>
            是"卖出去了又退回来"，算在退货当天，不动当时的营业额。
          </div>
        </Card>

        {/* ── 经过 ── */}
        <Card title="这张单的经过" className="flex w-[420px] shrink-0 flex-col overflow-auto">
          {d.events.map((e, n) => (
            <div key={`${e.saleId}-${n}`} className="flex gap-4 border-t border-line py-4 first:border-t-0">
              <span className="num w-14 shrink-0 text-[17px] text-ink-2">{e.time}</span>
              <div className="min-w-0">
                <div className={`text-[18px] ${e.current ? 'text-ink' : 'text-ink-2'}`}>
                  {EVENT_LABEL[e.kind]}　{e.summary}
                </div>
                {e.current && (
                  <span className="mt-1.5 inline-block rounded-lg bg-brand-50 px-2.5 py-1 text-[15px] text-brand-900">
                    当前版本
                  </span>
                )}
                {!e.current && e.saleId !== d.id && (
                  <button
                    type="button"
                    onClick={() => navigate(`/sales/${e.saleId}`)}
                    className="mt-1.5 text-[15px] text-brand-700 underline"
                  >
                    看那一版
                  </button>
                )}
              </div>
            </div>
          ))}

          <div className="mt-4 text-[15px] leading-relaxed text-muted">
            改完之后，库存、加权成本、欠款会自动跟着变。旧的那版不再进任何报表，但留在这里可以查。
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  muted,
  danger,
}: {
  label: string;
  value: string;
  muted?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center">
      <span className={`grow ${muted ? 'text-ink-2' : ''}`}>{label}</span>
      <span className={`num ${danger ? 'text-danger' : muted ? 'text-ink-2' : 'text-brand-900'}`}>
        {value}
      </span>
    </div>
  );
}
