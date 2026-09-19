import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api, endpoints } from '../api/client';
import { Card } from '../components/Card';
import { centsToYuan } from '../money';

interface ParsedRow {
  raw: string;
  ok: boolean;
  reason?: string;
  name?: string;
  baseUnit?: string;
  packUnit?: string | null;
  packRatio?: number;
  pinyinAbbr?: string;
  exists?: boolean;
}

interface ParseResult {
  rows: ParsedRow[];
  summary: { create: number; skip: number; invalid: number };
}

const SAMPLE = ['中华(硬) - 条 - 10包', '泸小二 - 瓶', '雪花勇闯 - 箱 - 12瓶'].join('\n');

/** 可就地编辑的价格格子。批量填价格是启用期最高频的操作，不该逐个进详情页 */
function PriceCell({
  value,
  onSave,
}: {
  value: number | null;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!editing) {
    return (
      <button
        type="button"
        onDoubleClick={() => {
          setDraft(value == null ? '' : centsToYuan(value));
          setEditing(true);
        }}
        onClick={() => {
          setDraft(value == null ? '' : centsToYuan(value));
          setEditing(true);
        }}
        className={`num w-28 rounded-lg px-2 py-1 text-right text-[19px] ${
          value == null ? 'bg-danger-50 text-danger' : 'hover:bg-page'
        }`}
      >
        {value == null ? '缺价格' : `¥${centsToYuan(value)}`}
      </button>
    );
  }

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        onSave(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          setEditing(false);
          onSave(draft);
        } else if (e.key === 'Escape') {
          setEditing(false);
        }
      }}
      className="num w-28 rounded-lg border border-brand-700 px-2 py-1 text-right text-[19px]"
    />
  );
}

export default function Products() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [text, setText] = useState(SAMPLE);
  const [preview, setPreview] = useState<ParseResult | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const products = useQuery({ queryKey: ['products', q], queryFn: () => endpoints.products(q) });
  const brands = useQuery({ queryKey: ['seedBrands'], queryFn: endpoints.seedBrands });

  const savePrice = useMutation({
    mutationFn: ({ id, field, value }: { id: number; field: 'priceBaseYuan' | 'pricePackYuan'; value: string }) =>
      api.patch<{ productId: number }>(`/api/products/${id}`, {
        [field]: value.trim() === '' ? null : value.trim(),
      }),
    onSuccess: () => {
      setFlash(null);
      qc.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (e) => setFlash((e as Error).message),
  });

  const parse = useMutation({
    mutationFn: () => api.post<ParseResult>('/api/products/parse-import', { text }),
    onSuccess: (r) => setPreview(r),
  });

  const doImport = useMutation({
    mutationFn: () => api.post<{ created: number; skipped: number; invalid: number }>(
      '/api/products/import',
      { text, category: 'other' },
    ),
    onSuccess: (r) => {
      setFlash(`导入完成：新建 ${r.created} 个，跳过 ${r.skipped} 个，看不懂 ${r.invalid} 行`);
      setPreview(null);
      qc.invalidateQueries({ queryKey: ['products'] });
    },
  });

  const importBrands = useMutation({
    mutationFn: (names: string[]) => api.post<{ created: number }>('/api/seed/import', { brands: names }),
    onSuccess: (r) => {
      setFlash(`按品牌导入了 ${r.created} 个商品骨架，价格留空`);
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['seedBrands'] });
    },
  });

  const items = products.data?.items ?? [];
  const missingPrice = items.filter((p) => p.price_base_cents == null && p.price_pack_cents == null).length;

  return (
    <div className="flex min-h-0 grow flex-col gap-5">
      <div className="flex shrink-0 items-center gap-4">
        <h1 className="m-0 text-2xl font-semibold">商品</h1>
        <span className="grow" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜商品名或拼音"
          aria-label="搜商品名或拼音"
          className="h-12 w-72 rounded-[10px] border border-line bg-card px-4 text-[18px]"
        />
        <button
          type="button"
          onClick={() => {
            window.location.href = '/api/products/export';
          }}
          className="h-12 rounded-[10px] border border-line bg-card px-5 text-[17px]"
        >
          导出 Excel
        </button>
      </div>

      {flash && <div className="shrink-0 rounded-xl bg-brand-50 px-5 py-3 text-[17px] text-brand-900">{flash}</div>}

      <div className="flex min-h-0 grow gap-5">
        <Card
          title="商品列表"
          extra={<span className="text-[17px] text-ink-2">点价格格子直接改，回车保存</span>}
          className="flex grow flex-col overflow-hidden"
        >
          <div className="flex h-12 shrink-0 items-center gap-4 text-[17px] text-ink-2">
            <span className="w-56">商品</span>
            <span className="w-28">品牌</span>
            <span className="w-36">单位换算</span>
            <span className="w-28 text-right">整包售价</span>
            <span className="w-28 text-right">单件售价</span>
            <span className="grow" />
          </div>

          <div className="min-h-0 grow overflow-auto">
            {items.length === 0 && <div className="pt-4 text-[17px] text-muted">还没有商品</div>}
            {items.map((p) => (
              <div key={p.id} className="flex h-16 items-center gap-4 border-t border-line text-[19px]">
                <span className="w-56">{p.name}</span>
                <span className="w-28 text-[17px] text-ink-2">{p.brand || '—'}</span>
                <span className="num w-36 text-[16px] text-ink-2">
                  {p.pack_unit ? `1 ${p.pack_unit} = ${p.pack_ratio} ${p.base_unit}` : p.base_unit}
                </span>
                <PriceCell
                  value={p.price_pack_cents}
                  onSave={(v) => savePrice.mutate({ id: p.id, field: 'pricePackYuan', value: v })}
                />
                <PriceCell
                  value={p.price_base_cents}
                  onSave={(v) => savePrice.mutate({ id: p.id, field: 'priceBaseYuan', value: v })}
                />
                <span className="grow" />
              </div>
            ))}
          </div>

          <div className="mt-4 flex shrink-0 items-center gap-4 border-t border-line pt-4 text-[17px] text-ink-2">
            共 <span className="num">{items.length}</span> 个商品
            {missingPrice > 0 && (
              <>
                <span className="text-muted">·</span>
                <span className="text-danger">
                  <span className="num">{missingPrice}</span> 个还没填价格
                </span>
              </>
            )}
            <span className="grow" />
            <span className="text-[16px] text-muted">价格没填不影响卖货，只是毛利算不出来</span>
          </div>
        </Card>

        <Card title="把商品弄进来" className="flex w-[520px] shrink-0 flex-col overflow-auto">
          <div className="mb-3 text-[17px] font-semibold">① 按品牌勾选导入</div>
          <div className="mb-2 flex flex-wrap gap-2">
            {(brands.data?.brands ?? []).slice(0, 12).map((b) => (
              <button
                key={b.brand}
                type="button"
                onClick={() => importBrands.mutate([b.brand])}
                disabled={b.alreadyImported === b.total}
                className={`h-11 rounded-[10px] border px-4 text-[17px] ${
                  b.alreadyImported === b.total
                    ? 'border-line text-muted'
                    : 'border-line hover:border-brand-700'
                }`}
              >
                {b.brand}
                <span className="num ml-2 text-[14px] text-muted">
                  {b.alreadyImported}/{b.total}
                </span>
              </button>
            ))}
          </div>
          <div className="mb-6 text-[15px] text-muted">
            只导骨架不带价格 —— 进价售价各店不同。**绝不全量导入**，搜索会被污染
          </div>

          <div className="mb-3 text-[17px] font-semibold">② 手工清单批量导入</div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="商品清单"
            className="num h-40 w-full resize-none rounded-xl border-2 border-line bg-card px-4 py-3 text-[17px] leading-loose"
          />
          <div className="mt-2 text-[15px] leading-relaxed text-muted">
            上面「导出 Excel」那份同时就是导入模板 —— 导出、填好、再导回来。
            <br />
            一行一个，两种写法：
            <br />
            <span className="num">名称 - 单位</span>　或
            <span className="num">名称 - 大单位 - N小单位</span>
          </div>

          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={() => parse.mutate()}
              className="h-13 grow rounded-xl border border-line bg-card text-[18px] font-semibold"
            >
              先看看解析结果
            </button>
            <button
              type="button"
              onClick={() => doImport.mutate()}
              className="h-13 grow rounded-xl bg-brand-700 text-[18px] font-semibold text-white"
            >
              导入
            </button>
          </div>

          {preview && (
            <div className="mt-4 rounded-xl border border-line p-4">
              <div className="num mb-2 text-[17px]">
                新建 {preview.summary.create} · 跳过 {preview.summary.skip} · 看不懂{' '}
                {preview.summary.invalid}
              </div>
              {preview.rows.map((r, i) => (
                <div key={i} className="border-t border-line py-2 text-[16px]">
                  <span className="num text-muted">{r.raw}</span>
                  <br />
                  {r.ok ? (
                    <span className={r.exists ? 'text-muted' : 'text-brand-900'}>
                      → {r.name}　{r.packUnit ? `1 ${r.packUnit} = ${r.packRatio} ${r.baseUnit}` : r.baseUnit}
                      　<span className="num">{r.pinyinAbbr}</span>
                      　{r.exists ? '已存在，跳过' : '新建'}
                    </span>
                  ) : (
                    // 一行看不懂不拖垮整批 —— 标出来让老板就地改
                    <span className="text-danger">→ {r.reason}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 text-[15px] leading-relaxed text-muted">
            ③ 卖货时搜不到的商品，回车就地建，不耽误这笔生意。
            <br />
            商品库是用出来的，不是录出来的。
          </div>
        </Card>
      </div>
    </div>
  );
}
