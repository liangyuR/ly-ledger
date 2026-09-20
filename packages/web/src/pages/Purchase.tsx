import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState } from 'react';

import { api, endpoints, type Product } from '../api/client';
import { Card } from '../components/Card';
import { Flash } from '../components/Flash';
import { Modal } from '../components/Modal';
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

/** 挑一样东西出来补货，只认这几个字段 —— 搜索结果和库存表都喂得进来 */
type Pickable = Pick<Product, 'id' | 'name' | 'base_unit' | 'pack_unit'>;

interface StockLine extends Pickable {
  pack_ratio: number;
  /** 结存，已经是格式化好的字符串。前端不做金额和数量运算 */
  qty: string;
  avgCost: string;
  negative: boolean;
  /** 近 90 天补过几次货 */
  restockCount: number;
  /** 最近一次进货是哪天。列表按它的月份分组，没进过货的是 null */
  lastIntake: string | null;
}

/** 最近入库表里的一行。金额是后端格式化好的字符串，前端不做金额运算 */
interface RecentPurchase {
  id: number;
  bizDate: string;
  /** 入库时的时分。同一天进两回货时靠它分辨 */
  time: string;
  summary: string;
  total: string;
  voided: boolean;
}

/** 某个商品是哪几次进的。老板找一批货是按商品找的，不是按单号 */
interface Intake {
  purchaseId: number;
  bizDate: string;
  time: string;
  /** 按录入单位：他录的是 3 条，这里就是 3 和「条」 */
  qty: string;
  unitLabel: string;
  baseUnit: string;
  unitCost: string;
  amount: string;
  voided: boolean;
  /** 这张单里还有别的商品 —— 撤销会一起撤掉，得先说一声 */
  otherItems: number;
}

/** 撤销确认框认的东西。最近入库的行和进货记录的行都能喂进来 */
interface UndoTarget {
  id: number;
  bizDate: string;
  time?: string;
  summary: string;
  total: string;
}

/** 点开一张进货单看到的东西。改日期、拆单、撤销都从这里点 */
interface PurchaseDetail {
  id: number;
  bizDate: string;
  time: string;
  total: string;
  paid: string;
  voided: boolean;
  items: {
    productId: number;
    name: string;
    /** 按录入单位：他录的是 3 条，这里就是 3 和「条」 */
    qty: string;
    unitLabel: string;
    baseUnit: string;
    unitCost: string;
    amount: string;
  }[];
}

/** "2026-09" → "2026 年 9 月"。没进过货的没有月份 */
function monthLabel(iso: string | null) {
  if (!iso) return '还没进过货';
  const [y, m] = iso.slice(0, 7).split('-');
  return `${y} 年 ${Number(m)} 月进的`;
}

function today() {
  return new Date().toLocaleDateString('sv-SE');
}

export default function Purchase() {
  const qc = useQueryClient();
  const [bizDate, setBizDate] = useState(today);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [pending, setPending] = useState<Pickable | null>(null);
  const [unit, setUnit] = useState<Unit>('pack');
  const [qty, setQty] = useState('1');
  const [cost, setCost] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [paid, setPaid] = useState('');
  const [flash, setFlash] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [newCosts, setNewCosts] = useState<{ productId: number; avgCost: string }[]>([]);
  /** 刚录完的那单，在最近入库表里标出来 —— 录错的十有八九就是它 */
  const [lastId, setLastId] = useState<number | null>(null);
  const [undoing, setUndoing] = useState<UndoTarget | null>(null);
  /** 正在看哪个商品的进货记录 */
  const [intakeOf, setIntakeOf] = useState<{ id: number; name: string } | null>(null);
  /** 点开的那张进货单 */
  const [opened, setOpened] = useState<number | null>(null);
  const [newDate, setNewDate] = useState('');
  /** 正在拆的那一行。qty 按录入单位填 */
  const [splitting, setSplitting] = useState<{
    productId: number;
    name: string;
    unitLabel: string;
    qty: string;
    date: string;
    /** 拆的是哪张单 */
    purchaseId: number;
  } | null>(null);
  /** 正在改哪张单的日期 */
  const [editingDate, setEditingDate] = useState<number | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  const search = useQuery({
    queryKey: ['products', query],
    queryFn: () => endpoints.products(query),
    enabled: query.trim().length > 0,
  });
  // 进来先看见的就是这张表：家底有多少、哪几样是每周都要补的
  const stock = useQuery({
    queryKey: ['stockOverview'],
    queryFn: () => api.get<{ items: StockLine[] }>('/api/stock'),
  });

  // 录错货的第一反应是「刚才那单撤了」，所以入库按钮旁边就得有这张表
  const recent = useQuery({
    queryKey: ['purchasesRecent'],
    queryFn: () => api.get<{ items: RecentPurchase[] }>('/api/purchases'),
  });

  const intake = useQuery({
    queryKey: ['productIntake', intakeOf?.id],
    queryFn: () => api.get<{ items: Intake[] }>(`/api/products/${intakeOf?.id}/intake`),
    enabled: intakeOf != null,
  });

  const detail = useQuery({
    queryKey: ['purchaseDetail', opened],
    queryFn: () => api.get<PurchaseDetail>(`/api/purchases/${opened}`),
    enabled: opened != null,
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

  /** 进货和撤销动的是同一批数字：库存、看板、常用商品、最近入库 */
  function refresh() {
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['frequent'] });
    qc.invalidateQueries({ queryKey: ['stockOverview'] });
    qc.invalidateQueries({ queryKey: ['purchasesRecent'] });
    qc.invalidateQueries({ queryKey: ['productIntake'] });
    qc.invalidateQueries({ queryKey: ['purchaseDetail'] });
  }

  function backToSearch() {
    setPending(null);
    setQuery('');
    setQty('1');
    setCost('');
    requestAnimationFrame(() => searchRef.current?.focus());
  }

  function pick(p: Pickable) {
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
      setLastId(r.purchaseId);
      setFlash({
        tone: 'ok',
        text: r.warnings.length
          ? `入库了，但有提醒：${r.warnings[0]}`
          : `入库了　合计 ¥${r.total}　录错了在右边撤销`,
      });
      setLines([]);
      setPaid('');
      refresh();
      backToSearch();
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  /** 撤销一次入库 —— 后端是作废原单 + 写一条反向流水，库里那张单留着 */
  const undo = useMutation({
    mutationFn: (id: number) =>
      api.post<{ purchaseId: number; warnings: string[] }>(`/api/purchases/${id}/void`, {}),
    onSuccess: (r) => {
      setFlash({
        tone: 'ok',
        text: r.warnings.length ? `撤销了，但有提醒：${r.warnings[0]}` : '撤销了，这批货退出库存',
      });
      // 撤的就是刚录那单时，「入库后成本变成这样」那块已经不成立了，收掉
      if (r.purchaseId === lastId) {
        setNewCosts([]);
        setLastId(null);
      }
      setUndoing(null);
      refresh();
    },
    onError: (e) => {
      setUndoing(null);
      setFlash({ tone: 'bad', text: (e as Error).message });
    },
  });

  /** 补录：昨天的货今天才录，日期得能改回去 */
  const setDate = useMutation({
    mutationFn: ({ id, date }: { id: number; date: string }) =>
      api.post<{ from: string; to: string }>(`/api/purchases/${id}/date`, { bizDate: date }),
    onSuccess: (r) => {
      setFlash({ tone: 'ok', text: `日期从 ${r.from} 改成了 ${r.to}` });
      refresh();
      qc.invalidateQueries({ queryKey: ['purchaseDetail'] });
    },
    onError: (e) => setFlash({ tone: 'bad', text: (e as Error).message }),
  });

  // 拆单：同一个商品分两批进的，录成了一张。
  // 内部是作废原单 + 建两张新单，所以拆完要关掉这个框 —— 原来那张 id 已经作废了
  const split = useMutation({
    mutationFn: ({ id, body }: { id: number; body: unknown }) =>
      api.post<{ warnings: string[] }>(`/api/purchases/${id}/split`, body),
    onSuccess: (r) => {
      setFlash({
        tone: 'ok',
        text: r.warnings.length ? `拆开了，但有提醒：${r.warnings[0]}` : '拆成两张单了',
      });
      setSplitting(null);
      setOpened(null);
      refresh();
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
    Escape: () => {
      if (undoing) setUndoing(null);
      else if (splitting) setSplitting(null);
      else if (opened != null) setOpened(null);
      else if (intakeOf) setIntakeOf(null);
      else if (pending) backToSearch();
      else setLines([]);
    },
  });

  return (
    <div className="flex min-h-0 grow flex-col gap-5">
      <div className="flex shrink-0 items-center gap-4">
        <h1 className="m-0 text-2xl font-semibold">库存</h1>
        <span className="text-[17px] text-ink-2">按最近进货的月份分组，新的在上面</span>
      </div>

      <div className="flex min-h-0 grow gap-5">
        <Card className="flex w-[1140px] shrink-0 flex-col overflow-hidden">
          <label className="mb-3 block text-[17px] text-ink-2">搜商品</label>
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
                onClick={addLine}
                className="flex h-13 items-center gap-2.5 rounded-[10px] bg-brand-700 px-6 text-[18px] font-semibold text-white"
              >
                <span className="num text-[13px] font-medium text-[#BFE0D4]">Enter</span>
                加入
              </button>
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

          {/* 本次进货压在上半截，下面那张库存表一直看得见 —— 补货时要反复对照 */}
          {lines.length > 0 && (
            <div className="mt-5 max-h-[38%] shrink-0 overflow-auto rounded-xl border border-line">
              <div className="flex h-12 items-center gap-4.5 border-b border-line px-5 text-[16px] text-ink-2">
                <span className="grow">本次进货</span>
                <span className="num">{lines.length} 项</span>
              </div>
              {lines.map((l) => (
                <div key={l.key} className="flex h-[58px] items-center gap-3.5 border-t border-line px-5">
                  <span className="grow text-[20px]">{l.name}</span>
                  <span className="num w-20 text-[18px] text-ink-2">
                    {l.qty} {l.unitLabel}
                  </span>
                  <span className="num w-24 text-right text-[18px] text-ink-2">¥{l.unitCostYuan}</span>
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
          )}

          {/* 搜的时候让位给候选，别让两张列表同时抢眼睛 */}
          {!query.trim() && (
            <div className="mt-5 flex min-h-0 grow flex-col overflow-hidden rounded-xl border border-line">
              <div className="flex h-12 shrink-0 items-center gap-4.5 border-b border-line px-5 text-[16px] text-ink-2">
                <span className="grow">现有库存　按进货月份分组，同月里常补的在前</span>
                <span className="num">{stock.data?.items.length ?? 0} 样</span>
              </div>

              <div className="min-h-0 grow overflow-auto">
                {(stock.data?.items ?? []).length === 0 && (
                  <div className="px-5 py-4 text-[17px] text-muted">
                    还没有商品。先去「商品」页把常卖的那几样弄进来
                  </div>
                )}
                {(stock.data?.items ?? []).map((l, i, arr) => {
                  // 月份变了就插一条分隔。粘在滚动容器顶上 ——
                  // 翻到列表中间时还得知道正在看哪个月
                  const month = l.lastIntake?.slice(0, 7) ?? null;
                  const prev = i > 0 ? (arr[i - 1].lastIntake?.slice(0, 7) ?? null) : undefined;
                  const newGroup = i === 0 || month !== prev;
                  return (
                  <Fragment key={l.id}>
                  {newGroup && (
                    <div className="sticky top-0 z-10 flex h-9 items-center border-b border-line bg-page px-5 text-[15px] font-medium text-ink-2">
                      {monthLabel(l.lastIntake)}
                    </div>
                  )}
                  {/* 一行两个点法：点商品去补货，点「补过几次」翻这批货是哪几次进的。
                      按钮不能套按钮，所以这里是 div 包两个按钮，不是一整个大按钮 */}
                  <div
                    className="flex h-[58px] w-full items-center gap-3.5 border-b border-line px-5"
                  >
                    <button
                      type="button"
                      onClick={() => pick(l)}
                      className="flex h-full grow items-center gap-3.5 text-left hover:bg-brand-50"
                    >
                      <span className="w-[230px] shrink-0 truncate text-[20px]">{l.name}</span>
                      <span className="num w-[150px] shrink-0 text-[15px] text-ink-2">
                        {l.pack_unit
                          ? `1 ${l.pack_unit} = ${l.pack_ratio} ${l.base_unit}`
                          : l.base_unit}
                      </span>
                      <span className="grow" />
                      {/* 负库存只提醒不拦路，且不靠颜色单独表意 —— 红字旁边带一句话 */}
                      {l.negative && <span className="text-[15px] text-danger">卖超了</span>}
                      <span
                        className={`num w-[130px] text-right text-[22px] font-medium ${
                          l.negative ? 'text-danger' : l.qty === '0' ? 'text-muted' : ''
                        }`}
                      >
                        {l.qty} {l.base_unit}
                      </span>
                      <span className="num w-[130px] text-right text-[16px] text-ink-2">
                        成本 ¥{l.avgCost}
                      </span>
                    </button>
                    {/* 补货次数本来就摆在这儿，点它翻记录是顺手的事 */}
                    <button
                      type="button"
                      onClick={() => setIntakeOf({ id: l.id, name: l.name })}
                      aria-label={`${l.name} 的进货记录`}
                      className="num h-11 w-[104px] shrink-0 rounded-[10px] text-[15px] text-muted hover:bg-brand-50 hover:text-brand-900"
                    >
                      {l.restockCount > 0 ? `补过 ${l.restockCount} 次` : '进货记录'}
                    </button>
                  </div>
                  </Fragment>
                  );
                })}
              </div>
            </div>
          )}
        </Card>

        <Card className="flex min-w-0 grow flex-col">
          <div className="flex flex-col gap-4">
            <div className="flex items-baseline">
              <span className="grow text-[20px] font-semibold">合计</span>
              <span className="num text-[40px] font-semibold text-brand-900">
                ¥{formatYuan(totalCents)}
              </span>
            </div>
            {/* 日期贴着「入库」按钮放：它管的就是这一次入库记在哪天。
                摆在页面标题栏时离动作最远，而且看着像在筛下面那张库存表 ——
                设成上个月忘了改回来，接下来几笔全进上个月，还不报错 */}
            <div className="flex items-center gap-3.5">
              <label htmlFor="bizDate" className="grow text-[18px] text-ink-2">
                入库日期
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
                这批货记在 <span className="num">{bizDate}</span>，不是今天
                <button
                  type="button"
                  onClick={() => setBizDate(today())}
                  className="rounded-[8px] px-2 py-0.5 text-[15px] text-muted underline decoration-dotted underline-offset-4 hover:text-brand-900"
                >
                  改回今天
                </button>
              </div>
            )}

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
          </div>

          {/* 撤销入口就摆在入库按钮上方 —— 录错的那一单，眼睛扫一下就能认出来 */}
          <div className="mt-6 flex min-h-0 grow flex-col overflow-hidden rounded-xl border border-line">
            <div className="flex h-12 shrink-0 items-center border-b border-line px-4 text-[16px] text-ink-2">
              <span className="grow">最近入库</span>
              <span className="text-muted">录错了就撤销</span>
            </div>
            <div className="min-h-0 grow overflow-auto">
              {(recent.data?.items ?? []).length === 0 && (
                <div className="px-4 py-4 text-[17px] text-muted">还没进过货</div>
              )}
              {(recent.data?.items ?? []).map((p, i) => (
                <div
                  key={p.id}
                  className={`px-4 py-3 ${i > 0 ? 'border-t border-line' : ''} ${
                    p.voided ? 'opacity-55' : ''
                  }`}
                >
                  <div className="flex items-baseline gap-2.5">
                    <span className="num text-[15px] text-ink-2">
                      {p.bizDate} {p.time}
                    </span>
                    {p.id === lastId && !p.voided && (
                      <span className="rounded-md bg-brand-50 px-2 py-0.5 text-[13px] text-brand-900">
                        刚录的
                      </span>
                    )}
                    <span className="grow" />
                    <span
                      className={`num text-[20px] font-medium ${p.voided ? 'line-through' : ''}`}
                    >
                      ¥{p.total}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-3">
                    <span className="grow truncate text-[18px]">{p.summary}</span>
                    {/* 撤过的单不删掉，留一行痕迹 —— 凭空消失会让人以为撤错了别的 */}
                    {p.voided ? (
                      <span className="shrink-0 text-[15px] text-muted">已撤销</span>
                    ) : (
                      // 改日期、拆单、撤销都在里面。三个按钮挤在这一行，
                      // 窗口一窄就折成三行
                      <button
                        type="button"
                        onClick={() => {
                          setNewDate(p.bizDate);
                          setSplitting(null);
                          setOpened(p.id);
                        }}
                        aria-label={`打开 ${p.bizDate} 入库的 ${p.summary}`}
                        className="h-10 shrink-0 rounded-[10px] px-3 text-[16px] text-muted hover:bg-brand-50 hover:text-brand-900"
                      >
                        改 · 撤
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Flash value={flash} className="mt-4" />

          <button
            type="button"
            onClick={submit}
            disabled={receive.isPending}
            className="mt-6 flex h-19 items-center justify-center gap-3 rounded-xl bg-brand-700 text-[22px] font-semibold text-white disabled:opacity-60"
          >
            {receive.isPending ? '处理中…' : '入库'}
          </button>
        </Card>
      </div>

      {/* 按商品翻进货记录。改日期和拆单都在这儿点 ——
          老板想的是「这 4 条中华 2 条六月 2 条七月」，不是「第 31 号单」 */}
      <Modal
        open={intakeOf != null}
        onClose={() => {
          setIntakeOf(null);
          setSplitting(null);
        }}
        title={`${intakeOf?.name ?? ''}　进货记录`}
      >
        <div className="max-h-[420px] overflow-auto rounded-xl border border-line">
          {(intake.data?.items ?? []).length === 0 && (
            <div className="px-4 py-5 text-[17px] text-muted">这个商品还没进过货</div>
          )}
          {(intake.data?.items ?? []).map((r) => (
            <div
              key={r.purchaseId}
              className={`border-b border-line px-4 py-3 last:border-b-0 ${
                r.voided ? 'opacity-55' : ''
              }`}
            >
              <div className="flex items-baseline gap-3">
                <span className="num text-[17px]">{r.bizDate}</span>
                <span className="num text-[14px] text-muted">{r.time}</span>
                <span className="grow" />
                <span className={`num text-[19px] font-medium ${r.voided ? 'line-through' : ''}`}>
                  ¥{r.amount}
                </span>
              </div>

              <div className="mt-1 flex items-center gap-3">
                <span className="num text-[18px]">
                  {r.qty} {r.unitLabel}
                </span>
                <span className="num text-[14px] text-muted">
                  成本 ¥{r.unitCost} / {r.baseUnit}
                </span>
                <span className="grow" />
                {r.voided ? (
                  <span className="text-[15px] text-muted">已撤销</span>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setSplitting(null);
                        setNewDate(r.bizDate);
                        setEditingDate(r.purchaseId);
                      }}
                      className="rounded-[10px] px-2.5 py-1 text-[15px] text-muted hover:bg-brand-50 hover:text-brand-900"
                    >
                      改日期
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingDate(null);
                        setSplitting({
                          productId: intakeOf!.id,
                          name: intakeOf!.name,
                          unitLabel: r.unitLabel,
                          qty: '',
                          date: r.bizDate,
                          purchaseId: r.purchaseId,
                        });
                      }}
                      className="rounded-[10px] px-2.5 py-1 text-[15px] text-muted hover:bg-brand-50 hover:text-brand-900"
                    >
                      拆开
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setUndoing({
                          id: r.purchaseId,
                          bizDate: r.bizDate,
                          time: r.time,
                          summary: `${intakeOf!.name} ${r.qty} ${r.unitLabel}${
                            r.otherItems > 0 ? `　连同另 ${r.otherItems} 样` : ''
                          }`,
                          total: r.amount,
                        })
                      }
                      className="rounded-[10px] px-2.5 py-1 text-[15px] text-muted hover:bg-danger-50 hover:text-danger"
                    >
                      撤销
                    </button>
                  </>
                )}
              </div>

              {/* 这张单里还有别的商品：撤销会把那些一起撤掉，不说清楚就是坑 */}
              {!r.voided && r.otherItems > 0 && (
                <div className="mt-1 text-[14px] text-muted">
                  这张单里还有 {r.otherItems} 样别的商品，撤销会一起撤掉
                </div>
              )}

              {editingDate === r.purchaseId && (
                <div className="mt-3 flex items-end gap-3 rounded-[10px] bg-page px-4 py-3">
                  <label className="flex flex-col gap-1.5 text-[15px] text-ink-2">
                    改到哪天
                    <input
                      type="date"
                      autoFocus
                      value={newDate}
                      onChange={(e) => setNewDate(e.target.value)}
                      aria-label="改到哪天"
                      className="num h-12 w-[180px] rounded-[10px] border border-line bg-card px-3 text-[17px]"
                    />
                  </label>
                  <span className="grow" />
                  <button
                    type="button"
                    onClick={() => setEditingDate(null)}
                    className="h-12 rounded-[10px] border border-line bg-card px-4 text-[16px]"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setDate.mutate({ id: r.purchaseId, date: newDate }, { onSuccess: () => setEditingDate(null) })
                    }
                    disabled={setDate.isPending || newDate === r.bizDate}
                    className="h-12 rounded-[10px] bg-brand-700 px-5 text-[16px] font-semibold text-white disabled:opacity-50"
                  >
                    改
                  </button>
                </div>
              )}

              {splitting?.purchaseId === r.purchaseId && (
                <div className="mt-3 flex flex-wrap items-end gap-3 rounded-[10px] bg-page px-4 py-3">
                  <label className="flex flex-col gap-1.5 text-[15px] text-ink-2">
                    挪走多少
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={splitting.qty}
                        onChange={(e) => setSplitting((v) => v && { ...v, qty: e.target.value })}
                        aria-label="挪走多少"
                        placeholder="2"
                        className="num h-12 w-20 rounded-[10px] border border-line bg-card px-3 text-[18px]"
                      />
                      <span className="text-[17px] text-ink-2">{r.unitLabel}</span>
                    </div>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[15px] text-ink-2">
                    挪到哪天
                    <input
                      type="date"
                      value={splitting.date}
                      onChange={(e) => setSplitting((v) => v && { ...v, date: e.target.value })}
                      aria-label="挪到哪天"
                      className="num h-12 w-[180px] rounded-[10px] border border-line bg-card px-3 text-[17px]"
                    />
                  </label>
                  <span className="grow" />
                  <button
                    type="button"
                    onClick={() => setSplitting(null)}
                    className="h-12 rounded-[10px] border border-line bg-card px-4 text-[16px]"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      split.mutate({
                        id: r.purchaseId,
                        body: {
                          productId: splitting.productId,
                          qty: splitting.qty.trim(),
                          bizDate: splitting.date,
                        },
                      })
                    }
                    disabled={split.isPending || !splitting.qty.trim()}
                    className="h-12 rounded-[10px] bg-brand-700 px-5 text-[16px] font-semibold text-white disabled:opacity-50"
                  >
                    拆开
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-4 text-[15px] leading-relaxed text-muted">
          拆开会把那张单换成两张：留在原日期的一张，挪到新日期的一张。
          货和进价都不变，只是分成了两笔账。
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={() => {
              setIntakeOf(null);
              setSplitting(null);
            }}
            className="flex h-13 items-center gap-2.5 rounded-[10px] border border-line bg-card px-5 text-[18px]"
          >
            <span className="num text-[13px] font-medium text-muted">Esc</span>
            关掉
          </button>
        </div>
      </Modal>

      {/* 一张进货单能做的三件事都在这儿：改日期、拆一部分到别的日期、整张撤销 */}
      <Modal open={opened != null} onClose={() => setOpened(null)} title="这张进货单">
        {detail.data && (
          <>
            <div className="mb-4 flex items-baseline gap-3">
              <span className="num text-[15px] text-muted">录于 {detail.data.time}</span>
              <span className="grow" />
              <span className="num text-[24px] font-semibold">¥{detail.data.total}</span>
            </div>

            {/* 补录是常态：昨天的货今天才录，日期得能改回去 */}
            <div className="mb-5 flex items-end gap-3">
              <label className="flex flex-col gap-1.5 text-[16px] text-ink-2">
                业务日期
                <input
                  type="date"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  aria-label="业务日期"
                  className="num h-13 w-[190px] rounded-[10px] border border-line bg-card px-3 text-[19px]"
                />
              </label>
              <button
                type="button"
                onClick={() => setDate.mutate({ id: detail.data.id, date: newDate })}
                disabled={setDate.isPending || newDate === detail.data.bizDate}
                className="h-13 rounded-[10px] border border-line bg-card px-5 text-[17px] disabled:opacity-40"
              >
                改到这天
              </button>
            </div>

            <div className="overflow-hidden rounded-xl border border-line">
              {detail.data.items.map((it) => (
                <div key={it.productId} className="border-b border-line px-4 py-3 last:border-b-0">
                  <div className="flex items-baseline gap-3">
                    <span className="grow truncate text-[19px]">{it.name}</span>
                    <span className="num text-[17px] text-ink-2">
                      {it.qty} {it.unitLabel}
                    </span>
                    <span className="num w-24 text-right text-[18px]">¥{it.amount}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setSplitting({
                          productId: it.productId,
                          name: it.name,
                          unitLabel: it.unitLabel,
                          qty: '',
                          date: bizDate,
                          purchaseId: detail.data.id,
                        })
                      }
                      className="shrink-0 rounded-[10px] px-2.5 py-1 text-[15px] text-muted hover:bg-brand-50 hover:text-brand-900"
                    >
                      拆一部分
                    </button>
                  </div>
                  <div className="num text-[14px] text-muted">
                    成本 ¥{it.unitCost} / {it.baseUnit}
                  </div>

                  {splitting?.productId === it.productId && (
                    <div className="mt-3 flex flex-wrap items-end gap-3 rounded-[10px] bg-page px-4 py-3">
                      <label className="flex flex-col gap-1.5 text-[15px] text-ink-2">
                        挪走多少
                        <div className="flex items-center gap-2">
                          <input
                            autoFocus
                            value={splitting.qty}
                            onChange={(e) =>
                              setSplitting((v) => v && { ...v, qty: e.target.value })
                            }
                            aria-label="挪走多少"
                            placeholder="2"
                            className="num h-12 w-20 rounded-[10px] border border-line bg-card px-3 text-[18px]"
                          />
                          <span className="text-[17px] text-ink-2">{it.unitLabel}</span>
                        </div>
                      </label>
                      <label className="flex flex-col gap-1.5 text-[15px] text-ink-2">
                        挪到哪天
                        <input
                          type="date"
                          value={splitting.date}
                          onChange={(e) =>
                            setSplitting((v) => v && { ...v, date: e.target.value })
                          }
                          aria-label="挪到哪天"
                          className="num h-12 w-[180px] rounded-[10px] border border-line bg-card px-3 text-[17px]"
                        />
                      </label>
                      <span className="grow" />
                      <button
                        type="button"
                        onClick={() => setSplitting(null)}
                        className="h-12 rounded-[10px] border border-line bg-card px-4 text-[16px]"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          split.mutate({
                            id: detail.data.id,
                            body: {
                              productId: splitting.productId,
                              qty: splitting.qty.trim(),
                              bizDate: splitting.date,
                            },
                          })
                        }
                        disabled={split.isPending || !splitting.qty.trim()}
                        className="h-12 rounded-[10px] bg-brand-700 px-5 text-[16px] font-semibold text-white disabled:opacity-50"
                      >
                        拆开
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-4 text-[15px] leading-relaxed text-muted">
              拆单会把这张单换成两张：留在原日期的一张，和挪到新日期的一张。
              货和进价都不变，只是分成了两笔账。
            </div>

            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  const row = recent.data?.items.find((x) => x.id === opened);
                  setOpened(null);
                  if (row) setUndoing(row);
                }}
                className="h-13 rounded-[10px] px-4 text-[17px] text-muted hover:bg-danger-50 hover:text-danger"
              >
                撤销这次入库
              </button>
              <span className="grow" />
              <button
                type="button"
                onClick={() => setOpened(null)}
                className="flex h-13 items-center gap-2.5 rounded-[10px] border border-line bg-card px-5 text-[18px]"
              >
                <span className="num text-[13px] font-medium text-muted">Esc</span>
                关掉
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* 撤销要确认：它动的是库存和成本，不像删一行那样能再点一下加回来 */}
      <Modal open={!!undoing} onClose={() => setUndoing(null)} title="撤销这次入库？">
        <div className="text-[21px]">{undoing?.summary}</div>
        <div className="num mt-1.5 text-[17px] text-ink-2">
          {undoing?.bizDate} {undoing?.time}　合计 ¥{undoing?.total}
        </div>

        {/* docs/05 要求写明：撤销不回溯历史成本。不说清楚，老板会以为能恢复原状 */}
        <div className="mt-5 rounded-xl bg-page px-5 py-4 text-[16px] leading-relaxed text-ink-2">
          这批货从库存里扣回去，成本也跟着算回去。
          <br />
          但<span className="font-medium text-ink">已经卖出去的单，成本不会变</span>
          —— 上个月的利润不会因为今天撤一单而变。
        </div>

        <div className="mt-6 flex justify-end gap-3">
          {/* 焦点默认落在「再想想」：这个框里回车最该做的事是什么都不做 */}
          <button
            type="button"
            autoFocus
            onClick={() => setUndoing(null)}
            className="flex h-13 items-center gap-2.5 rounded-[10px] border border-line bg-card px-5 text-[18px]"
          >
            <span className="num text-[13px] font-medium text-muted">Esc</span>
            再想想
          </button>
          <button
            type="button"
            onClick={() => undoing && undo.mutate(undoing.id)}
            disabled={undo.isPending}
            className="h-13 rounded-[10px] bg-danger px-6 text-[18px] font-semibold text-white disabled:opacity-60"
          >
            {undo.isPending ? '处理中…' : '撤销入库'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
