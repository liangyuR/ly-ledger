import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { api, endpoints, type Product } from '../api/client';
import { Card } from '../components/Card';
import { useHotkeys } from '../hooks/useHotkeys';
import { formatYuan, lineAmountCents, yuanToCents } from '../money';

type Unit = 'base' | 'pack';

interface Line {
  key: string;
  productId: number;
  name: string;
  unit: Unit;
  unitLabel: string;
  qty: string;
  unitCostYuan: string;
  amountCents: number;
}

interface Supplier {
  id: number;
  name: string;
}

export default function Purchase() {
  const qc = useQueryClient();
  const [bizDate, setBizDate] = useState(() => new Date().toLocaleDateString('sv-SE'));
  const [supplierId, setSupplierId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [pending, setPending] = useState<Product | null>(null);
  const [unit, setUnit] = useState<Unit>('pack');
  const [qty, setQty] = useState('1');
  const [cost, setCost] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [paid, setPaid] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [newCosts, setNewCosts] = useState<{ productId: number; avgCost: string }[]>([]);

  const searchRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  const search = useQuery({
    queryKey: ['products', query],
    queryFn: () => endpoints.products(query),
    enabled: query.trim().length > 0,
  });
  const suppliers = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api.get<{ items: Supplier[] }>('/api/suppliers'),
  });

  const candidates = query.trim() ? (search.data?.items ?? []) : [];
  useEffect(() => setHighlight(0), [query]);
  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  useEffect(() => {
    if (pending) {
      qtyRef.current?.focus();
      qtyRef.current?.select();
    }
  }, [pending]);

  const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);

  function backToSearch() {
    setPending(null);
    setQuery('');
    setQty('1');
    setCost('');
    requestAnimationFrame(() => searchRef.current?.focus());
  }

  function pick(p: Product) {
    setPending(p);
    setUnit(p.pack_unit ? 'pack' : 'base');
    setQty('1');
    setCost('');
  }

  function addLine() {
    if (!pending) return;
    try {
      if (!cost.trim()) throw new Error('填一下进价');
      const unitCostCents = yuanToCents(cost);
      const label = unit === 'pack' ? (pending.pack_unit ?? pending.base_unit) : pending.base_unit;
      setLines((prev) => [
        ...prev,
        {
          key: `${pending.id}-${Date.now()}`,
          productId: pending.id,
          name: pending.name,
          unit,
          unitLabel: label,
          qty,
          unitCostYuan: cost,
          amountCents: lineAmountCents(qty, unitCostCents),
        },
      ]);
      setFlash(null);
      backToSearch();
    } catch (e) {
      setFlash({ tone: 'bad', text: (e as Error).message });
    }
  }

  const receive = useMutation({
    mutationFn: (body: unknown) => api.post<{ purchaseId: number; total: string; newCosts: { productId: number; avgCost: string }[]; warnings: string[] }>('/api/purchases/receive', body),
    onSuccess: (r) => {
      setNewCosts(r.newCosts);
      setFlash({
        tone: 'ok',
        text: r.warnings.length ? `入库了，但有提醒：${r.warnings[0]}` : `入库了　合计 ¥${r.total}`,
      });
      setLines([]);
      setPaid('');
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['frequent'] });
      backToSearch();
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  function submit() {
    if (lines.length === 0) {
      setFlash({ tone: 'bad', text: '还没选商品' });
      return;
    }
    receive.mutate({
      bizDate,
      supplierId: supplierId ? Number(supplierId) : null,
      paidYuan: paid.trim() || undefined,
      items: lines.map((l) => ({
        productId: l.productId,
        unit: l.unit,
        qty: l.qty,
        unitCostYuan: l.unitCostYuan,
      })),
    });
  }

  useHotkeys({
    F8: submit,
    Escape: () => (pending ? backToSearch() : setLines([])),
  });

  return (
    <div className="flex min-h-0 grow flex-col gap-5">
      <div className="flex shrink-0 items-center gap-4">
        <h1 className="m-0 text-2xl font-semibold">进货</h1>
        <span className="grow" />
        <label className="flex items-center gap-2.5 text-[17px] text-ink-2">
          供应商
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className="h-12 w-52 rounded-[10px] border border-line bg-card px-3 text-[19px]"
          >
            <option value="">不填</option>
            {suppliers.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2.5 text-[17px] text-ink-2">
          业务日期
          <input
            type="date"
            value={bizDate}
            onChange={(e) => setBizDate(e.target.value)}
            className="num h-12 w-[200px] rounded-[10px] border border-line bg-card px-4 text-[19px]"
          />
        </label>
      </div>

      <div className="flex min-h-0 grow gap-5">
        <Card className="flex w-[1140px] shrink-0 flex-col overflow-hidden">
          <label className="mb-3 block text-[17px] text-ink-2">
            搜商品<span className="text-muted">　进货频率低，可以慢一点</span>
          </label>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, candidates.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const hit = candidates[highlight];
                if (hit) pick(hit);
              }
            }}
            placeholder="如 zhy / zhonghua"
            aria-label="搜商品"
            className={`h-18 w-full rounded-xl border-2 bg-card px-5 text-[26px] ${
              query ? 'border-brand-500' : 'border-line'
            }`}
          />

          {candidates.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-xl border border-line">
              {candidates.slice(0, 6).map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pick(p)}
                  className={`flex h-[70px] w-full items-center gap-5 px-5 text-left ${
                    i === highlight ? 'bg-brand-50' : i > 0 ? 'border-t border-line' : ''
                  }`}
                >
                  <span className="w-[190px] text-[21px]">{p.name}</span>
                  <span className="text-[16px] text-ink-2">
                    {p.pack_unit ? `1 ${p.pack_unit} = ${p.pack_ratio} ${p.base_unit}` : p.base_unit}
                  </span>
                </button>
              ))}
            </div>
          )}

          {pending && (
            <div className="mt-4 flex items-end gap-5 rounded-xl border border-brand-700 bg-brand-50 px-6 py-5">
              <div className="text-[21px] font-semibold">{pending.name}</div>
              <label className="flex flex-col gap-2 text-[16px] text-ink-2">
                数量
                <input
                  ref={qtyRef}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addLine()}
                  aria-label="数量"
                  className="num h-13 w-[110px] rounded-[10px] border border-line bg-card px-3 text-[21px]"
                />
              </label>
              <button
                type="button"
                onClick={() => setUnit(unit === 'pack' ? 'base' : 'pack')}
                disabled={!pending.pack_unit}
                className="h-13 rounded-[10px] border border-line bg-card px-5 text-[19px] disabled:opacity-40"
              >
                {unit === 'pack' ? (pending.pack_unit ?? pending.base_unit) : pending.base_unit}
              </button>
              <label className="flex flex-col gap-2 text-[16px] text-ink-2">
                进价<span className="text-muted">（按上面这个单位）</span>
                <input
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addLine()}
                  aria-label="进价"
                  placeholder="0.00"
                  className="num h-13 w-[140px] rounded-[10px] border border-line bg-card px-3 text-[21px]"
                />
              </label>
              <span className="grow" />
              <span className="text-[16px] text-ink-2">Enter 加入</span>
            </div>
          )}

          {newCosts.length > 0 && (
            <div className="mt-5 rounded-xl bg-brand-50 px-6 py-5">
              <div className="mb-2.5 text-[17px] text-brand-900">入库后加权成本变成这样</div>
              {newCosts.map((c) => (
                <div key={c.productId} className="num text-[19px] text-brand-900">
                  商品 #{c.productId}　¥{c.avgCost} / 基础单位
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="flex min-w-0 grow flex-col">
          <div className="mb-5 flex items-baseline gap-3.5">
            <h2 className="m-0 text-[19px] font-semibold">本次进货</h2>
            <span className="text-[17px] text-ink-2">填的是进价</span>
          </div>

          <div className="min-h-0 grow overflow-auto">
            {lines.length === 0 && <div className="text-[17px] text-muted">还没选商品</div>}
            {lines.map((l) => (
              <div key={l.key} className="flex h-[58px] items-center gap-3.5 border-t border-line">
                <span className="grow text-[20px]">{l.name}</span>
                <span className="num w-16 text-[18px] text-ink-2">
                  {l.qty} {l.unitLabel}
                </span>
                <span className="num w-20 text-right text-[18px] text-ink-2">¥{l.unitCostYuan}</span>
                <span className="num w-28 text-right text-[22px] font-medium">
                  ¥{formatYuan(l.amountCents)}
                </span>
                <button
                  type="button"
                  onClick={() => setLines((c) => c.filter((x) => x.key !== l.key))}
                  aria-label={`删掉 ${l.name}`}
                  className="text-[16px] text-muted hover:text-danger"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-4 border-t-2 border-line pt-4">
            <div className="flex items-baseline">
              <span className="grow text-[20px] font-semibold">合计</span>
              <span className="num text-[40px] font-semibold text-brand-900">
                ¥{formatYuan(totalCents)}
              </span>
            </div>
            <div className="flex items-center gap-3.5">
              <label htmlFor="paid" className="grow text-[18px] text-ink-2">
                已付
              </label>
              <input
                id="paid"
                value={paid}
                onChange={(e) => setPaid(e.target.value)}
                placeholder="0.00"
                className="num h-12 w-[140px] rounded-[10px] border border-line bg-card px-3 text-right text-[21px]"
              />
            </div>
            <div className="-mt-2 text-right text-[15px] text-muted">
              一期只记录，不算供应商欠款
            </div>
          </div>

          {flash && (
            <div
              className={`mt-4 rounded-xl px-5 py-3.5 text-[17px] ${
                flash.tone === 'ok' ? 'bg-brand-50 text-brand-900' : 'bg-danger-50 text-danger'
              }`}
            >
              {flash.text}
            </div>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={receive.isPending}
            className="mt-6 flex h-19 items-center justify-center gap-3 rounded-xl bg-brand-700 text-[22px] font-semibold text-white disabled:opacity-60"
          >
            <span className="num text-[14px] font-medium text-[#BFE0D4]">F8</span>
            {receive.isPending ? '处理中…' : '入库'}
          </button>
        </Card>
      </div>
    </div>
  );
}
