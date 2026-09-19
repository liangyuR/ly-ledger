/**
 * 启用向导。
 *
 * 完成标准是**卖出第一笔**，不是"把表填完"（docs/04）。所以：
 *   · 前三步的次要按钮都写「以后再说」，不写「跳过」—— 暗示这事本来就不用做完
 *   · 第四步不在向导里做，是把人送到真正的卖货页去卖一笔真的
 *   · 任何一步都能直接退出，进度留在看板的清单上
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, type Product } from '../api/client';
import { useOnboarding, useRefreshOnboarding } from '../hooks/useOnboarding';

interface Brand {
  brand: string;
  category: string;
  total: number;
  alreadyImported: number;
}

const CATEGORY_LABEL: Record<string, string> = {
  cigarette: '香烟',
  liquor: '白酒',
  other: '啤酒 · 其他',
};

const STEP_TITLES = ['勾牌子', '填价格', '现有库存', '试卖一笔'];

function Check() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function Stepper({ active }: { active: number }) {
  return (
    <div className="flex items-center gap-4">
      {STEP_TITLES.map((name, i) => {
        const n = i + 1;
        const done = n < active;
        const on = n === active;
        return (
          <div key={name} className="flex items-center gap-4">
            {i > 0 && <span className="h-px w-11 bg-line" />}
            <div className="flex items-center gap-3">
              <span
                className={`flex size-10 shrink-0 items-center justify-center rounded-full border text-[19px] font-semibold ${
                  done || on
                    ? 'border-brand-700 bg-brand-700 text-white'
                    : 'border-line bg-card text-muted'
                }`}
              >
                {done ? <Check /> : n}
              </span>
              <span
                className={`text-[19px] ${on ? 'font-semibold text-ink' : done ? 'text-ink-2' : 'text-muted'}`}
              >
                {name}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Shell({
  step,
  title,
  sub,
  aside,
  footer,
  children,
}: {
  step: number;
  title: string;
  sub: ReactNode;
  aside: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 grow flex-col items-center">
      <div className="flex min-h-0 w-[1280px] grow flex-col">
        <Stepper active={step} />
        <h1 className="mt-10 mb-2.5 text-[40px] font-semibold">{title}</h1>
        <p className="mt-0 mb-8 text-[20px] leading-relaxed text-ink-2">{sub}</p>

        <div className="flex min-h-0 grow gap-7">
          <div className="min-w-0 grow overflow-auto">{children}</div>
          <div className="w-[360px] shrink-0 overflow-auto">{aside}</div>
        </div>

        <div className="mt-8 flex shrink-0 items-center gap-4">{footer}</div>
      </div>
    </div>
  );
}

const primaryBtn =
  'h-19 rounded-xl border border-brand-700 bg-brand-700 px-9 text-[22px] font-semibold text-white disabled:opacity-50';
const ghostBtn = 'h-19 rounded-xl border border-line bg-card px-7 text-[22px] font-semibold text-ink-2';

// ───────────────────────── 第 1 步：勾牌子 ─────────────────────────

function StepBrands({ onNext, onLater }: { onNext: () => void; onLater: () => void }) {
  const refresh = useRefreshOnboarding();
  const brands = useQuery({
    queryKey: ['seedBrands'],
    queryFn: () => api.get<{ brands: Brand[] }>('/api/seed/brands'),
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // 已经导过的牌子默认勾上 —— 老板中途退出再进来，不该看起来像白做了
  useEffect(() => {
    const already = (brands.data?.brands ?? [])
      .filter((b) => b.alreadyImported > 0)
      .map((b) => b.brand);
    if (already.length > 0) setPicked(new Set(already));
  }, [brands.data]);

  const importing = useMutation({
    mutationFn: (list: string[]) =>
      api.post<{ created: number }>('/api/seed/import', { brands: list }),
    onSuccess: () => {
      refresh();
      onNext();
    },
  });

  const all = brands.data?.brands ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, Brand[]>();
    for (const b of all) {
      const list = m.get(b.category) ?? [];
      list.push(b);
      m.set(b.category, list);
    }
    return [...m];
  }, [all]);

  const skuCount = all.filter((b) => picked.has(b.brand)).reduce((s, b) => s + b.total, 0);

  const toggle = (brand: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(brand)) next.delete(brand);
      else next.add(brand);
      return next;
    });

  return (
    <Shell
      step={1}
      title="你店里卖哪些牌子？"
      sub={
        <>
          只导商品骨架，<strong className="font-semibold text-ink-2">不带价格</strong> ——
          名称、规格、拼音、条包换算都帮你填好了。
        </>
      }
      aside={
        <>
          <div className="rounded-2xl bg-brand-50 px-6 py-6">
            <div className="flex items-baseline gap-2.5">
              <span className="num text-[48px] leading-none font-semibold text-brand-900">
                {skuCount}
              </span>
              <span className="text-[19px] text-brand-900">个商品骨架</span>
            </div>
            <div className="mt-2 text-[17px] text-brand-900">
              来自已勾的 <span className="num">{picked.size}</span> 个牌子
            </div>
          </div>
          <div className="mt-4 rounded-2xl bg-card px-5 py-5 text-[17px] leading-loose text-ink-2">
            <strong className="font-semibold text-ink">只勾你真卖的。</strong>
            <br />
            勾多了，以后搜 <span className="num">zh</span> 会跳出一堆你根本不卖的牌子，搜索就废了。
            <br />
            <br />
            漏了也不要紧 —— 卖货时搜不到，回车就地建。
          </div>
        </>
      }
      footer={
        <>
          <button
            type="button"
            disabled={picked.size === 0 || importing.isPending}
            onClick={() => importing.mutate([...picked])}
            className={primaryBtn}
          >
            {importing.isPending
              ? '正在导入…'
              : picked.size === 0
                ? '先勾几个牌子'
                : `导入这 ${skuCount} 个商品，下一步`}
          </button>
          <button type="button" onClick={onLater} className={ghostBtn}>
            以后再说
          </button>
          <span className="grow" />
          <span className="text-[17px] text-muted">随时可以退出，进度会留着</span>
        </>
      }
    >
      {brands.isLoading && <div className="text-[19px] text-muted">正在读商品目录…</div>}
      {brands.isError && (
        <div className="text-[19px] text-danger">
          读不到商品目录：{(brands.error as Error).message}
          <div className="mt-2 text-[17px] text-ink-2">
            这一步可以先「以后再说」，商品也能在卖货时就地建。
          </div>
        </div>
      )}
      {groups.map(([category, list]) => (
        <div key={category} className="mb-6">
          <div className="mb-3.5 text-[17px] text-ink-2">{CATEGORY_LABEL[category] ?? category}</div>
          <div className="flex flex-wrap gap-3">
            {list.map((b) => {
              const on = picked.has(b.brand);
              return (
                <button
                  key={b.brand}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(b.brand)}
                  className={`flex h-14 items-center gap-2.5 rounded-[11px] border px-5 text-[19px] ${
                    on ? 'border-brand-700 bg-brand-50 text-brand-900' : 'border-line bg-card text-ink'
                  }`}
                >
                  <span
                    className={`flex size-5 shrink-0 items-center justify-center rounded-md border ${
                      on ? 'border-brand-700 bg-brand-700 text-white' : 'border-muted bg-card'
                    }`}
                  >
                    {on && <Check />}
                  </span>
                  {b.brand}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </Shell>
  );
}

// ───────────────────────── 第 2 步：填价格 ─────────────────────────

interface PriceDraft {
  base: string;
  pack: string;
}

function StepPrices({ onNext, onLater }: { onNext: () => void; onLater: () => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshOnboarding();
  const products = useQuery({
    queryKey: ['products', ''],
    queryFn: () => api.get<{ items: Product[] }>('/api/products'),
  });
  const [draft, setDraft] = useState<Record<number, PriceDraft>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = products.data?.items ?? [];

  const valueOf = (p: Product, key: keyof PriceDraft): string => {
    const d = draft[p.id]?.[key];
    if (d !== undefined) return d;
    const cents = key === 'pack' ? p.price_pack_cents : p.price_base_cents;
    return cents == null ? '' : (cents / 100).toFixed(2).replace(/\.00$/, '');
  };

  const filled = items.filter(
    (p) => valueOf(p, 'base').trim() !== '' || valueOf(p, 'pack').trim() !== '',
  ).length;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      for (const [id, d] of Object.entries(draft)) {
        await api.patch(`/api/products/${id}`, {
          priceBaseYuan: d.base.trim() === '' ? null : d.base.trim(),
          pricePackYuan: d.pack.trim() === '' ? null : d.pack.trim(),
        });
      }
      void qc.invalidateQueries({ queryKey: ['products'] });
      refresh();
      onNext();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const cell = (p: Product, key: keyof PriceDraft, label: string) => {
    const v = valueOf(p, key);
    return (
      <input
        value={v}
        aria-label={`${p.name} ${label}`}
        placeholder="—"
        onChange={(e) =>
          setDraft((prev) => {
            const cur = prev[p.id] ?? { base: valueOf(p, 'base'), pack: valueOf(p, 'pack') };
            return { ...prev, [p.id]: { ...cur, [key]: e.target.value } };
          })
        }
        className={`num h-13 w-[180px] rounded-[10px] border bg-card px-3.5 text-right text-[21px] ${
          v.trim() === '' ? 'border-line' : 'border-brand-700'
        }`}
      />
    );
  };

  return (
    <Shell
      step={2}
      title="挑几个最常卖的，填个售价"
      sub={
        <>
          整条价和单包价<strong className="font-semibold text-ink-2">分开填</strong> —— 一条 550、单包
          57，不是 55。
        </>
      }
      aside={
        <>
          <div className="rounded-2xl bg-brand-50 px-6 py-6">
            <div className="flex items-baseline gap-2.5">
              <span className="num text-[48px] leading-none font-semibold text-brand-900">
                {filled}
              </span>
              <span className="text-[19px] text-brand-900">个填好了</span>
            </div>
            <div className="mt-2 text-[17px] text-brand-900">
              {filled > 0 ? '够开张了' : '填一个就能开张'}
            </div>
          </div>
          <div className="mt-4 rounded-2xl bg-card px-5 py-5 text-[17px] leading-loose text-ink-2">
            <strong className="font-semibold text-ink">别想着一次填完。</strong>
            <br />
            先填你今天就会卖的那几个，三五个就够。
            <br />
            <br />
            剩下的等真卖到那天，在卖货页当场填一个，软件会记住，下次就不用再填了。
          </div>
        </>
      }
      footer={
        <>
          <button type="button" disabled={saving} onClick={() => void save()} className={primaryBtn}>
            {saving ? '正在保存…' : '下一步'}
          </button>
          <button type="button" onClick={onLater} className={ghostBtn}>
            以后再说
          </button>
          <span className="grow" />
          <span className="text-[17px] text-muted">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : (
              '价格各省不同、还常调，外部没法替你填'
            )}
          </span>
        </>
      }
    >
      {items.length === 0 ? (
        <div className="text-[19px] text-muted">
          还没有商品。回上一步勾几个牌子，或者以后在卖货时就地建。
        </div>
      ) : (
        <div className="rounded-2xl border border-line bg-card px-6 py-5">
          <div className="flex h-12 items-center gap-5 text-[17px] text-ink-2">
            <span className="w-[280px]">商品</span>
            <span className="w-[180px] text-right">整条 / 整箱售价</span>
            <span className="w-[180px] text-right">单包 / 单瓶售价</span>
            <span className="grow" />
          </div>
          {items.map((p) => {
            const done = valueOf(p, 'base').trim() !== '' || valueOf(p, 'pack').trim() !== '';
            return (
              <div key={p.id} className="flex h-18 items-center gap-5 border-t border-line">
                <span className="w-[280px] truncate text-[20px]">{p.name}</span>
                {p.pack_unit ? (
                  cell(p, 'pack', '整条售价')
                ) : (
                  <span className="w-[180px] text-right text-[16px] text-muted">不分条</span>
                )}
                {cell(p, 'base', '单包售价')}
                <span
                  className={`grow text-right text-[16px] ${done ? 'text-brand-900' : 'text-muted'}`}
                >
                  {done ? '可以卖了' : '以后卖到时再填'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

// ───────────────────────── 第 3 步：期初库存 ─────────────────────────

function StepStock({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const refresh = useRefreshOnboarding();
  const products = useQuery({
    queryKey: ['products', ''],
    queryFn: () => api.get<{ items: Product[] }>('/api/products'),
  });
  const [draft, setDraft] = useState<Record<number, { qty: string; cost: string }>>({});
  const [error, setError] = useState<string | null>(null);

  // 只问刚填过价的那几个 —— 全列出来等于要求他盘全店的货，多半会放弃
  const items = (products.data?.items ?? []).filter(
    (p) => p.price_base_cents != null || p.price_pack_cents != null,
  );

  const rows = Object.entries(draft)
    .filter(([, d]) => d.qty.trim() !== '' && d.cost.trim() !== '')
    .map(([id, d]) => {
      const p = items.find((x) => x.id === Number(id));
      return {
        productId: Number(id),
        // 有条就按条录，没条按包 —— 老板盘货时数的是条
        unit: (p?.pack_unit ? 'pack' : 'base') as 'pack' | 'base',
        qty: d.qty.trim(),
        unitCostYuan: d.cost.trim(),
      };
    });

  const save = useMutation({
    mutationFn: () => api.post('/api/onboarding/opening-stock', { items: rows }),
    onSuccess: () => {
      refresh();
      onNext();
    },
    onError: (e) => setError((e as Error).message),
  });

  const skip = useMutation({
    mutationFn: () => api.post('/api/onboarding/skip-stock'),
    onSuccess: () => {
      refresh();
      onSkip();
    },
  });

  const put = (id: number, key: 'qty' | 'cost', v: string) =>
    setDraft((prev) => {
      const cur = prev[id] ?? { qty: '', cost: '' };
      return { ...prev, [id]: { ...cur, [key]: v } };
    });

  return (
    <Shell
      step={3}
      title="货架上现在有多少？"
      sub={
        <>
          只问你刚填过价的那几个。<strong className="font-semibold text-ink-2">可以跳过</strong>
          ，但先看看右边会有什么后果。
        </>
      }
      aside={
        <>
          <div className="rounded-2xl bg-danger-50 px-5 py-5 text-[17px] leading-loose text-ink-2">
            <strong className="font-semibold text-danger">跳过会怎样？</strong>
            <br />
            这些货卖出去时，软件不知道你当初花多少钱进的，
            <strong className="font-semibold text-danger">毛利会显示成全额售价</strong> —— 卖一条中华
            550，账上写赚了 550。
            <br />
            <br />
            不会一直错：这个商品下次进货时，成本就校正回来了。
            <br />
            <br />
            所以跳过也能用，只是头几周的毛利数字不能当真。
          </div>
          <div className="mt-4 rounded-2xl bg-card px-5 py-5 text-[17px] leading-loose text-ink-2">
            这会记成一张<strong className="font-semibold text-ink">「期初」进货单</strong>
            ，跟平时进货走同一套账，没有特殊规则。
            <br />
            <br />
            记错了可以在单据里改。
          </div>
        </>
      }
      footer={
        <>
          <button
            type="button"
            disabled={rows.length === 0 || save.isPending}
            onClick={() => save.mutate()}
            className={primaryBtn}
          >
            {save.isPending ? '正在记…' : '记下来，下一步'}
          </button>
          <button type="button" onClick={() => skip.mutate()} className={ghostBtn}>
            跳过 —— 我以后进货时再说
          </button>
          <span className="grow" />
          {error && <span className="text-[17px] text-danger">{error}</span>}
        </>
      }
    >
      {items.length === 0 ? (
        <div className="text-[19px] text-muted">还没有填过价的商品，没什么可盘的。直接跳过就行。</div>
      ) : (
        <div className="rounded-2xl border border-line bg-card px-6 py-5">
          <div className="flex h-12 items-center gap-5 text-[17px] text-ink-2">
            <span className="w-[280px]">商品</span>
            <span className="w-[180px] text-right">现在有多少</span>
            <span className="w-[180px] text-right">当初进价</span>
            <span className="grow pl-4">单位</span>
          </div>
          {items.map((p) => {
            const unit = p.pack_unit ?? p.base_unit;
            const d = draft[p.id];
            return (
              <div key={p.id} className="flex h-18 items-center gap-5 border-t border-line">
                <span className="w-[280px] truncate text-[20px]">{p.name}</span>
                <input
                  value={d?.qty ?? ''}
                  aria-label={`${p.name} 数量`}
                  placeholder="—"
                  onChange={(e) => put(p.id, 'qty', e.target.value)}
                  className={`num h-13 w-[180px] rounded-[10px] border bg-card px-3.5 text-right text-[21px] ${
                    d?.qty ? 'border-brand-700' : 'border-line'
                  }`}
                />
                <input
                  value={d?.cost ?? ''}
                  aria-label={`${p.name} 进价`}
                  placeholder="—"
                  onChange={(e) => put(p.id, 'cost', e.target.value)}
                  className={`num h-13 w-[180px] rounded-[10px] border bg-card px-3.5 text-right text-[21px] ${
                    d?.cost ? 'border-brand-700' : 'border-line'
                  }`}
                />
                <span className="grow pl-4 text-[17px] text-ink-2">{unit}</span>
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

// ───────────────────────── 第 4 步：试卖一笔 ─────────────────────────

function StepFirstSale({ onLeave }: { onLeave: () => void }) {
  const navigate = useNavigate();
  return (
    <Shell
      step={4}
      title="最后一步：卖一笔试试"
      sub={
        <>
          <strong className="font-semibold text-ink-2">这才是装好了的标志</strong> —— 不是把表填完。
        </>
      }
      aside={
        <div className="rounded-2xl bg-card px-5 py-5 text-[17px] leading-loose text-ink-2">
          卖不出去也没关系。向导会留在看板上，随时可以回来接着弄。
          <br />
          <br />
          要是怎么都卖不动，把 <span className="num">logs</span> 文件夹里的日志发给维护者 ——
          那说明这软件在你店里跑不起来，是它的问题，不是你的。
        </div>
      }
      footer={
        <>
          <button type="button" onClick={() => navigate('/sell')} className={primaryBtn}>
            去卖货页，卖第一笔
          </button>
          <button type="button" onClick={onLeave} className={ghostBtn}>
            先不试了，直接开始用
          </button>
        </>
      }
    >
      <div className="rounded-2xl bg-brand-50 px-8 py-7">
        <div className="text-[26px] font-semibold text-brand-900">怎么卖</div>
        <div className="mt-3 text-[20px] leading-loose text-brand-900">
          在搜索框里敲商品名的拼音首字母，比如中华就敲 <span className="num font-semibold">zh</span>
          ，回车选中，再回车加入，然后按 <span className="num font-semibold">F8</span> 收钱。
          <br />
          这一笔卖成了，就算装好了 ——{' '}
          <strong className="font-semibold">前面几步填得全不全都不重要。</strong>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-line bg-card px-8 py-7 text-[19px] leading-loose text-ink-2">
        卖货页上会有一条提示带着你走，卖成第一笔它就自己消失。
        <br />
        试卖的这一笔要是不想留，进单据点「撤掉」就行 —— 库存和账都会退回去。
      </div>
    </Shell>
  );
}

// ───────────────────────── 外壳 ─────────────────────────

export default function Onboarding() {
  const navigate = useNavigate();
  const state = useOnboarding();
  const [step, setStep] = useState<number | null>(null);

  // 从哪一步开始，由现状决定，不由"上次走到哪"决定 ——
  // 老板中途去商品页自己导了商品，回来就该直接落在填价格那步
  useEffect(() => {
    if (step != null || !state.data) return;
    const firstUndone = state.data.steps.findIndex((s) => !s.done && !s.skipped);
    setStep(firstUndone === -1 ? 4 : firstUndone + 1);
  }, [state.data, step]);

  if (state.isError) {
    return <div className="text-[19px] text-danger">连不上后台：{(state.error as Error).message}</div>;
  }
  if (step == null) return <div className="text-[19px] text-muted">正在看你走到哪一步了…</div>;

  return (
    <>
      {step === 1 && <StepBrands onNext={() => setStep(2)} onLater={() => setStep(2)} />}
      {step === 2 && <StepPrices onNext={() => setStep(3)} onLater={() => setStep(3)} />}
      {step === 3 && <StepStock onNext={() => setStep(4)} onSkip={() => setStep(4)} />}
      {step === 4 && <StepFirstSale onLeave={() => navigate('/')} />}
    </>
  );
}
