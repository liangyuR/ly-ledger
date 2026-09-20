import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { api, endpoints, type Product } from '../api/client';
import FirstSaleHint from '../components/FirstSaleHint';
import { Card } from '../components/Card';
import { Flash } from '../components/Flash';
import { Modal } from '../components/Modal';
import { useHotkeys } from '../hooks/useHotkeys';
import { centsToYuan, formatYuan, lineAmountCents, yuanToCents } from '../money';

type Unit = 'base' | 'pack';

interface CartLine {
  key: string;
  productId: number;
  name: string;
  unit: Unit;
  unitLabel: string;
  qty: string;
  unitPriceYuan: string;
  amountCents: number;
}

interface Customer {
  id: number;
  name: string;
}

const METHODS = [
  { key: 'cash', label: '现金' },
  { key: 'wechat', label: '微信' },
  { key: 'alipay', label: '支付宝' },
  { key: 'transfer', label: '转账' },
] as const;

interface FrequentItem extends Product {
  priceBase: string | null;
  pricePack: string | null;
}

/** 有整条价就默认按条卖 —— 九成单子是整条走的 */
function defaultUnit(p: Product): Unit {
  return p.pack_unit && p.price_pack_cents != null ? 'pack' : 'base';
}

function unitLabel(p: Product, unit: Unit): string {
  return unit === 'pack' ? (p.pack_unit ?? p.base_unit) : p.base_unit;
}

function priceOf(p: Product, unit: Unit): string {
  const cents = unit === 'pack' ? p.price_pack_cents : p.price_base_cents;
  return cents == null ? '' : centsToYuan(cents);
}

function today() {
  return new Date().toLocaleDateString('sv-SE');
}

export default function Sell() {
  const qc = useQueryClient();
  const [bizDate, setBizDate] = useState(today);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [pending, setPending] = useState<Product | null>(null);
  const [unit, setUnit] = useState<Unit>('pack');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState('0');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  /** cart = 正常结账；credit = F9 挂账；partial = F7 部分付 */
  const [mode, setMode] = useState<'cart' | 'credit' | 'partial'>('cart');
  const [custQuery, setCustQuery] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [partialAmount, setPartialAmount] = useState('');
  const [partialMethod, setPartialMethod] = useState<(typeof METHODS)[number]['key']>('cash');

  /** 搜不到时就地建商品。商品库不全不能阻塞记账（docs/01） */
  const [creating, setCreating] = useState<{ name: string; unit: string; price: string } | null>(null);

  /** 挂账时搜不到客户，就地建一个，建好自动选中，不用跳去挂账归还页 */
  const [creatingCustomer, setCreatingCustomer] = useState<{ name: string; phone: string } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const custRef = useRef<HTMLInputElement>(null);

  const search = useQuery({
    queryKey: ['products', query],
    queryFn: () => endpoints.products(query),
    enabled: query.trim().length > 0,
  });

  const frequent = useQuery({
    queryKey: ['frequent'],
    queryFn: () => api.get<{ items: FrequentItem[] }>('/api/products/frequent'),
  });

  const customers = useQuery({
    queryKey: ['customers', custQuery],
    queryFn: () => api.get<{ items: Customer[] }>(`/api/customers?q=${encodeURIComponent(custQuery)}`),
    enabled: mode !== 'cart',
  });

  const candidates = query.trim() ? (search.data?.items ?? []) : [];

  useEffect(() => setHighlight(0), [query]);
  useEffect(() => {
    if (mode !== 'cart') custRef.current?.focus();
  }, [mode]);
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // ── 金额预览。整数分，不碰浮点；按 F8 后以后端返回的为准 ──
  const originalCents = cart.reduce((s, l) => s + l.amountCents, 0);
  const discountCents = useMemo(() => {
    try {
      return discount.trim() ? yuanToCents(discount) : 0;
    } catch {
      return 0;
    }
  }, [discount]);
  const totalCents = originalCents - discountCents;

  function backToSearch() {
    setPending(null);
    setQuery('');
    setQty('1');
    setPrice('');
    requestAnimationFrame(() => searchRef.current?.focus());
  }

  function pick(p: Product) {
    const u = defaultUnit(p);
    setPending(p);
    setUnit(u);
    setQty('1');
    setPrice(priceOf(p, u));
    requestAnimationFrame(() => {
      qtyRef.current?.focus();
      qtyRef.current?.select();
    });
  }

  function addToCart() {
    if (!pending) return;
    if (!price.trim()) {
      setFlash({ tone: 'bad', text: '这个商品还没填价格，直接在这里输一个' });
      return;
    }
    try {
      const unitPriceCents = yuanToCents(price);
      setCart((prev) => [
        ...prev,
        {
          key: `${pending.id}-${unit}-${Date.now()}`,
          productId: pending.id,
          name: pending.name,
          unit,
          unitLabel: unitLabel(pending, unit),
          qty,
          unitPriceYuan: price,
          amountCents: lineAmountCents(qty, unitPriceCents),
        },
      ]);
      setFlash(null);
      backToSearch();
    } catch (e) {
      setFlash({ tone: 'bad', text: (e as Error).message });
    }
  }

  const createProduct = useMutation({
    mutationFn: (body: unknown) => api.post<{ productId: number }>('/api/products', body),
    onSuccess: (r, vars) => {
      const v = vars as { name: string; baseUnit: string; priceBaseYuan: string };
      // 建好直接加进这笔单，不打断这笔生意
      setCart((prev) => [
        ...prev,
        {
          key: `${r.productId}-new-${Date.now()}`,
          productId: r.productId,
          name: v.name,
          unit: 'base',
          unitLabel: v.baseUnit,
          qty: '1',
          unitPriceYuan: v.priceBaseYuan,
          amountCents: lineAmountCents('1', yuanToCents(v.priceBaseYuan)),
        },
      ]);
      setCreating(null);
      setFlash({ tone: 'ok', text: `建好了「${v.name}」，已加进这笔单` });
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['frequent'] });
      backToSearch();
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  function submitNewProduct() {
    if (!creating) return;
    if (!creating.price.trim()) {
      setFlash({ tone: 'bad', text: '填个售价就能开单了，进价以后进货时再说' });
      return;
    }
    createProduct.mutate({
      name: creating.name,
      baseUnit: creating.unit,
      priceBaseYuan: creating.price,
    });
  }

  const createCustomer = useMutation({
    mutationFn: (body: unknown) => api.post<{ customerId: number }>('/api/customers', body),
    onSuccess: (r, vars) => {
      const v = vars as { name: string };
      // 建好直接选中，接着走挂账，不用再搜一遍
      setCustomer({ id: r.customerId, name: v.name });
      setCreatingCustomer(null);
      setCustQuery('');
      setFlash({ tone: 'ok', text: `建好了「${v.name}」，已选中` });
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  function submitNewCustomer() {
    if (!creatingCustomer) return;
    if (!creatingCustomer.name.trim()) {
      setFlash({ tone: 'bad', text: '填个客户名' });
      return;
    }
    createCustomer.mutate({
      name: creatingCustomer.name.trim(),
      phone: creatingCustomer.phone.trim() || undefined,
    });
  }

  const checkout = useMutation({
    mutationFn: (body: unknown) => endpoints.checkout(body),
    onSuccess: (r) => {
      setFlash({ tone: 'ok', text: `完成　应收 ¥${r.total}　毛利 ¥${r.grossProfit}` });
      setCart([]);
      setDiscount('0');
      setMode('cart');
      setCustomer(null);
      setCustQuery('');
      setPartialAmount('');
      qc.invalidateQueries({ queryKey: ['frequent'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      // 卖成第一笔，上手提示当场消失 —— 拖到下次刷新，老板会以为没生效
      qc.invalidateQueries({ queryKey: ['onboarding'] });
      // 成交价回写到了商品上，搜索结果里的默认价要跟着变
      qc.invalidateQueries({ queryKey: ['products'] });
      backToSearch();
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  function submitCash() {
    if (cart.length === 0) {
      setFlash({ tone: 'bad', text: '还没选商品' });
      return;
    }
    checkout.mutate({
      bizDate,
      settleType: 'cash',
      discountYuan: discountCents ? centsToYuan(discountCents) : undefined,
      items: cart.map((l) => ({
        productId: l.productId,
        unit: l.unit,
        qty: l.qty,
        unitPriceYuan: l.unitPriceYuan,
      })),
    });
  }

  function openCredit(next: 'credit' | 'partial') {
    if (cart.length === 0) {
      setFlash({ tone: 'bad', text: '还没选商品' });
      return;
    }
    setFlash(null);
    setMode(next);
  }

  function submitCredit() {
    if (!customer) {
      setFlash({ tone: 'bad', text: '先选一个客户' });
      return;
    }
    checkout.mutate({
      bizDate,
      settleType: 'credit',
      customerId: customer.id,
      discountYuan: discountCents ? centsToYuan(discountCents) : undefined,
      items: cart.map((l) => ({
        productId: l.productId,
        unit: l.unit,
        qty: l.qty,
        unitPriceYuan: l.unitPriceYuan,
      })),
      // 部分付不是第三种结算方式：一张挂账单 + 一笔同日收款
      partialPay:
        mode === 'partial' && partialAmount.trim()
          ? { amountYuan: partialAmount, method: partialMethod }
          : undefined,
    });
  }

  useHotkeys({
    F8: () => (mode === 'cart' ? submitCash() : submitCredit()),
    F9: () => openCredit('credit'),
    F7: () => openCredit('partial'),
    Escape: () => {
      if (mode !== 'cart') {
        if (creatingCustomer) setCreatingCustomer(null);
        else {
          setMode('cart');
          setCustomer(null);
          setCustQuery('');
        }
      } else if (creating) setCreating(null);
      else if (pending) backToSearch();
      else if (cart.length) setCart([]);
    },
  });

  // 数字键直选常用商品，**只在搜索框为空时生效** —— 否则输数量会误触发
  useHotkeys(
    Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        String(i + 1),
        () => {
          if (query || pending) return;
          const item = frequent.data?.items[i];
          if (item) pick(item);
        },
      ]),
    ),
  );

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
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
      else if (query.trim()) {
        setCreating({ name: query.trim(), unit: '瓶', price: '' });
      }
    }
  }

  function onQtyKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addToCart();
    } else if (e.key === 'Tab' && pending?.pack_unit) {
      e.preventDefault();
      const next: Unit = unit === 'pack' ? 'base' : 'pack';
      setUnit(next);
      setPrice(priceOf(pending, next));
    }
  }

  return (
    <div className="flex min-h-0 grow flex-col gap-5">
      <FirstSaleHint />

      <div className="flex shrink-0 items-center gap-4">
        <h1 className="m-0 text-2xl font-semibold">卖货</h1>
      </div>

      <div className="flex min-h-0 grow gap-5">
        {/* 左：搜索与常用商品 */}
        <Card className="flex w-[1140px] shrink-0 flex-col overflow-hidden">
          <label className="mb-3 block text-[17px] text-ink-2">
            搜商品<span className="text-muted">　拼音首字母或全拼都行</span>
          </label>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
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
                  <span className="text-[16px] text-ink-2">{p.spec || p.base_unit}</span>
                  <span className="grow" />
                  {p.price_pack_cents != null && (
                    <span className="num text-[19px]">
                      {p.pack_unit} ¥{centsToYuan(p.price_pack_cents)}
                    </span>
                  )}
                  {p.price_base_cents != null && (
                    <span className="num w-[110px] text-right text-[19px] text-ink-2">
                      {p.base_unit} ¥{centsToYuan(p.price_base_cents)}
                    </span>
                  )}
                </button>
              ))}
              <div className="border-t border-line px-5 py-3 text-[16px] text-muted">
                ↑↓ 选择　Enter 加入　Tab 切换{candidates[0]?.pack_unit ?? '包装'}/
                {candidates[0]?.base_unit ?? '单位'}
              </div>
            </div>
          )}

          {creating && (
            <div className="mt-4 rounded-xl border border-dashed border-line bg-page px-6 py-5">
              <div className="text-[20px]">没找到「{creating.name}」</div>
              <div className="mt-1.5 text-[17px] text-ink-2">
                直接建，建完自动加进这笔单 —— 不用离开这个页面
              </div>
              <div className="mt-4 flex items-end gap-4">
                <label className="flex flex-col gap-2 text-[16px] text-ink-2">
                  商品名
                  <input
                    value={creating.name}
                    onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                    aria-label="新商品名"
                    className="h-13 w-56 rounded-[10px] border border-line bg-card px-3 text-[19px]"
                  />
                </label>
                <label className="flex flex-col gap-2 text-[16px] text-ink-2">
                  单位
                  <input
                    value={creating.unit}
                    onChange={(e) => setCreating({ ...creating, unit: e.target.value })}
                    aria-label="新商品单位"
                    className="h-13 w-24 rounded-[10px] border border-line bg-card px-3 text-[19px]"
                  />
                </label>
                <label className="flex flex-col gap-2 text-[16px] text-ink-2">
                  售价
                  <input
                    autoFocus
                    value={creating.price}
                    onChange={(e) => setCreating({ ...creating, price: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && submitNewProduct()}
                    placeholder="0.00"
                    aria-label="新商品售价"
                    className="num h-13 w-32 rounded-[10px] border border-line bg-card px-3 text-[19px]"
                  />
                </label>
                <button
                  type="button"
                  onClick={submitNewProduct}
                  className="h-13 rounded-[10px] bg-brand-700 px-6 text-[18px] font-semibold text-white"
                >
                  建好并加入本单
                </button>
              </div>
              <div className="mt-3 text-[15px] text-muted">
                拼音自动生成。规格、箱规以后再补，不阻塞这笔生意
              </div>
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
                  onKeyDown={onQtyKeyDown}
                  aria-label="数量"
                  className="num h-13 w-[110px] rounded-[10px] border border-line bg-card px-3 text-[21px]"
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  const next: Unit = unit === 'pack' ? 'base' : 'pack';
                  setUnit(next);
                  setPrice(priceOf(pending, next));
                }}
                disabled={!pending.pack_unit}
                className="h-13 rounded-[10px] border border-line bg-card px-5 text-[19px] disabled:opacity-40"
              >
                {unitLabel(pending, unit)}
                <span className="num ml-2 text-[13px] text-muted">Tab</span>
              </button>
              <label className="flex flex-col gap-2 text-[16px] text-ink-2">
                单价
                <input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  onKeyDown={onQtyKeyDown}
                  aria-label="单价"
                  className="num h-13 w-[130px] rounded-[10px] border border-line bg-card px-3 text-[21px]"
                />
              </label>
              <span className="grow" />
              <button
                type="button"
                onClick={backToSearch}
                className="flex h-13 items-center gap-2.5 rounded-[10px] border border-line bg-card px-5 text-[18px]"
              >
                <span className="num text-[13px] font-medium text-muted">Esc</span>
                取消
              </button>
              <button
                type="button"
                onClick={addToCart}
                className="flex h-13 items-center gap-2.5 rounded-[10px] bg-brand-700 px-6 text-[18px] font-semibold text-white"
              >
                <span className="num text-[13px] font-medium text-[#BFE0D4]">Enter</span>
                加入
              </button>
            </div>
          )}

          <div className="mt-6 min-h-0 grow overflow-auto">
            <div className="mb-3 text-[17px] text-ink-2">
              常用商品　<span className="text-muted">按近 30 天销量，数字键直选</span>
            </div>
            <div className="grid grid-cols-4 gap-3.5">
              {(frequent.data?.items ?? []).map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pick(p)}
                  className="flex h-[86px] flex-col items-start justify-center gap-1.5 rounded-xl border border-line bg-card px-4 text-left"
                >
                  <span className="flex items-center gap-2.5">
                    <span className="num flex size-6 items-center justify-center rounded-[7px] bg-brand-500 text-[14px] text-white">
                      {i + 1}
                    </span>
                    <span className="text-[19px]">{p.name}</span>
                  </span>
                  <span className="num pl-[34px] text-[16px] text-ink-2">
                    {p.pricePack
                      ? `${p.pack_unit} ¥${p.pricePack}`
                      : p.priceBase
                        ? `${p.base_unit} ¥${p.priceBase}`
                        : '未填价'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </Card>

        {/* 右：购物车与结账 */}
        <Card className="flex min-w-0 grow flex-col">
          <h2 className="m-0 mb-5 text-[19px] font-semibold">已选</h2>

          <div className="min-h-0 grow overflow-auto">
            {cart.length === 0 && <div className="text-[17px] text-muted">还没选商品</div>}
            {cart.map((l) => (
              <div key={l.key} className="flex flex-col gap-1.5 border-t border-line py-3.5">
                <div className="flex items-start gap-3">
                  <span className="grow text-[19px] leading-snug break-words">{l.name}</span>
                  <button
                    type="button"
                    onClick={() => setCart((c) => c.filter((x) => x.key !== l.key))}
                    aria-label={`删掉 ${l.name}`}
                    className="shrink-0 rounded-full px-2 text-[18px] text-muted hover:text-danger"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="num text-[16px] text-ink-2">
                    {l.qty} {l.unitLabel} × ¥{l.unitPriceYuan}
                  </span>
                  <span className="num shrink-0 text-[22px] font-medium">
                    ¥{formatYuan(l.amountCents)}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-4 border-t-2 border-line pt-4">
            <div className="flex items-center">
              <span className="grow text-[18px] text-ink-2">折前</span>
              <span className="num text-[24px] font-medium text-ink-2">¥{formatYuan(originalCents)}</span>
            </div>
            <div className="flex items-center gap-3.5">
              <label htmlFor="discount" className="grow text-[18px] text-ink-2">
                抹零
              </label>
              <input
                id="discount"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                className="num h-12 w-[120px] rounded-[10px] border border-line bg-card px-3 text-right text-[21px]"
              />
            </div>
            <div className="flex items-baseline">
              <span className="grow text-[20px] font-semibold">应收</span>
              <span className="num text-[40px] font-semibold text-brand-900">
                ¥{formatYuan(totalCents)}
              </span>
            </div>

            {/* 日期贴着结账按钮放：它管的就是这一单记在哪天。
                摆在页面标题栏时离动作最远，设成上个月忘了改回来，
                接下来几单全进上个月，还不报错 */}
            <div className="flex items-center gap-3.5">
              <label htmlFor="bizDate" className="grow text-[18px] text-ink-2">
                记在哪天
              </label>
              <input
                id="bizDate"
                type="date"
                value={bizDate}
                onChange={(e) => setBizDate(e.target.value)}
                className={`num h-12 w-[180px] rounded-[10px] border bg-card px-3 text-[19px] ${
                  bizDate === today() ? 'border-line' : 'border-brand-700 bg-brand-50'
                }`}
              />
            </div>
            {/* 不是今天就说一句。补录是常态，但「忘了改回来」也是常态 */}
            {bizDate !== today() && (
              <div className="flex items-center gap-2.5 text-[16px] text-brand-900">
                这单记在 <span className="num">{bizDate}</span>，不是今天
                <button
                  type="button"
                  onClick={() => setBizDate(today())}
                  className="rounded-[8px] px-2 py-0.5 text-[15px] text-muted underline decoration-dotted underline-offset-4 hover:text-brand-900"
                >
                  改回今天
                </button>
              </div>
            )}
          </div>

          <Flash value={flash} className="mt-4" />

          {mode === 'cart' ? (
            <div className="mt-6 flex flex-col gap-3.5">
              <button
                type="button"
                onClick={submitCash}
                disabled={checkout.isPending}
                className="flex h-19 items-center justify-center gap-3 rounded-xl bg-brand-700 text-[22px] font-semibold text-white disabled:opacity-60"
              >
                {checkout.isPending ? '处理中…' : '现金收讫'}
              </button>
              <div className="flex gap-3.5">
                <button
                  type="button"
                  onClick={() => openCredit('credit')}
                  className="flex h-14 grow items-center justify-center gap-2.5 rounded-xl border border-line bg-card text-[19px] font-semibold"
                >
                  挂账
                </button>
                <button
                  type="button"
                  onClick={() => openCredit('partial')}
                  className="flex h-14 grow items-center justify-center gap-2.5 rounded-xl border border-line bg-card text-[19px] font-semibold"
                >
                  部分付
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-6 flex flex-col gap-3.5 border-t-2 border-line pt-5">
              <div className="flex items-baseline gap-3">
                <h3 className="m-0 text-[19px] font-semibold">挂给谁</h3>
                <span className="grow" />
                <button
                  type="button"
                  onClick={() => {
                    setMode('cart');
                    setCustomer(null);
                    setCustQuery('');
                  }}
                  className="flex items-center gap-2 rounded-[8px] px-3 py-1.5 text-[16px] text-ink-2"
                >
                  <span className="num text-[13px] font-medium text-muted">Esc</span>
                  退回现金结账
                </button>
              </div>

              <input
                ref={custRef}
                value={custQuery}
                onChange={(e) => setCustQuery(e.target.value)}
                placeholder="搜客户拼音"
                aria-label="搜客户"
                className="h-14 w-full rounded-xl border-2 border-brand-500 bg-card px-4 text-[21px]"
              />

              <div className="flex flex-wrap gap-2.5">
                {(customers.data?.items ?? []).slice(0, 6).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCustomer(c)}
                    className={`h-13 rounded-[10px] border px-5 text-[19px] ${
                      customer?.id === c.id
                        ? 'border-brand-700 bg-brand-50 text-brand-900'
                        : 'border-line'
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
                {(customers.data?.items.length ?? 0) === 0 && !creatingCustomer && (
                  <button
                    type="button"
                    onClick={() => setCreatingCustomer({ name: custQuery.trim(), phone: '' })}
                    className="h-13 rounded-[10px] border border-dashed border-line px-5 text-[19px] text-ink-2"
                  >
                    没找到，新建「{custQuery.trim() || '客户'}」
                  </button>
                )}
              </div>

              <Modal open={!!creatingCustomer} onClose={() => setCreatingCustomer(null)} title="新建客户">
                <div className="mb-5 text-[16px] text-ink-2">建好自动选中，接着挂这单</div>
                <div className="flex flex-col gap-4">
                  <label className="flex flex-col gap-2 text-[16px] text-ink-2">
                    客户名
                    <input
                      autoFocus
                      value={creatingCustomer?.name ?? ''}
                      onChange={(e) =>
                        setCreatingCustomer((c) => c && { ...c, name: e.target.value })
                      }
                      onKeyDown={(e) => e.key === 'Enter' && submitNewCustomer()}
                      aria-label="新客户名"
                      className="h-13 w-full rounded-[10px] border border-line bg-card px-3 text-[19px]"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-[16px] text-ink-2">
                    电话<span className="text-muted">（选填）</span>
                    <input
                      value={creatingCustomer?.phone ?? ''}
                      onChange={(e) =>
                        setCreatingCustomer((c) => c && { ...c, phone: e.target.value })
                      }
                      onKeyDown={(e) => e.key === 'Enter' && submitNewCustomer()}
                      aria-label="新客户电话"
                      className="num h-13 w-full rounded-[10px] border border-line bg-card px-3 text-[19px]"
                    />
                  </label>
                </div>
                <div className="mt-6 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setCreatingCustomer(null)}
                    className="h-13 rounded-[10px] border border-line bg-card px-5 text-[18px]"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={submitNewCustomer}
                    disabled={createCustomer.isPending}
                    className="h-13 rounded-[10px] bg-brand-700 px-6 text-[18px] font-semibold text-white disabled:opacity-60"
                  >
                    建好并选中
                  </button>
                </div>
              </Modal>

              {/* 只有按了 F7 才出现这两行 —— 部分付是第三条路径，不得污染前两条 */}
              {mode === 'partial' && (
                <div className="mt-2 flex flex-col gap-3">
                  <div className="flex items-end gap-4">
                    <label className="flex flex-col gap-2 text-[16px] text-ink-2">
                      已收金额
                      <input
                        value={partialAmount}
                        onChange={(e) => setPartialAmount(e.target.value)}
                        placeholder="0.00"
                        aria-label="已收金额"
                        className="num h-13 w-[150px] rounded-[10px] border border-line bg-card px-3 text-[21px]"
                      />
                    </label>
                    <div className="flex gap-2">
                      {METHODS.map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          onClick={() => setPartialMethod(m.key)}
                          className={`h-13 rounded-[10px] border px-4 text-[17px] ${
                            partialMethod === m.key
                              ? 'border-brand-700 bg-brand-50 text-brand-900'
                              : 'border-line'
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {customer && partialAmount.trim() && (
                    <div className="rounded-xl bg-page px-4 py-3 text-[18px]">
                      本单 <span className="num">¥{formatYuan(totalCents)}</span>　已收{' '}
                      <span className="num">¥{partialAmount}</span>　剩余记在{customer.name}账上
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={submitCredit}
                disabled={checkout.isPending || !customer}
                className="mt-2 flex h-19 items-center justify-center gap-3 rounded-xl bg-brand-700 text-[22px] font-semibold text-white disabled:opacity-40"
              >
                {checkout.isPending ? '处理中…' : '确认'}
              </button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
