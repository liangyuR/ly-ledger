import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api, endpoints, exportXlsx } from '../api/client';
import type { Product } from '../api/client';
import { Card } from '../components/Card';
import { Flash } from '../components/Flash';
import { Modal } from '../components/Modal';
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

/** 商品表回导：导之前先让他看见会新建什么、改什么 */
interface SheetPreview {
  picked: boolean;
  file?: string;
  path?: string;
  create: number;
  update: number;
  same: number;
  bad: number;
  rows: {
    rowNo: number;
    name: string;
    outcome: 'create' | 'update' | 'same' | 'bad';
    reason: string | null;
    changes: string[];
    /** 有一部分没照做的说明，比如单位锁着 */
    notes: string[];
  }[];
}

interface DeleteResult {
  name: string;
  mode: 'deleted' | 'deactivated';
  purchases?: number;
  sales?: number;
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
  const [doomed, setDoomed] = useState<Product | null>(null);
  const [sheet, setSheet] = useState<SheetPreview | null>(null);

  const products = useQuery({ queryKey: ['products', q], queryFn: () => endpoints.products(q) });
  const brands = useQuery({ queryKey: ['seedBrands'], queryFn: endpoints.seedBrands });

  // 真删还是停用后端说了算 —— 界面只负责把它的判断翻成人话
  const remove = useMutation({
    mutationFn: (id: number) => api.del<DeleteResult>(`/api/products/${id}`),
    onSuccess: (r) => {
      setDoomed(null);
      setFlash(
        r.mode === 'deleted'
          ? `「${r.name}」已经删掉了`
          : `「${r.name}」有账在（进货 ${r.purchases} 笔、卖出 ${r.sales} 笔），没法真删 ——` +
            '已停用，列表和搜索里不再出现，老账照样查得到',
      );
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['seedBrands'] });
    },
    onError: (e) => {
      setDoomed(null);
      setFlash((e as Error).message);
    },
  });

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

  // 选文件和解析在后端一个命令里做完 —— 路径留在前端存着，他换一份表重选时容易导错那份
  const pickSheet = useMutation({
    mutationFn: () => api.post<SheetPreview>('/api/products/sheet-preview'),
    onSuccess: (r) => {
      // 点了取消不是错误，什么都不用说
      if (!r.picked) return;
      if (r.create === 0 && r.update === 0 && r.bad === 0) {
        setFlash(`「${r.file}」跟库里一模一样，没什么要改的`);
        return;
      }
      setSheet(r);
    },
    onError: (e) => setFlash((e as Error).message),
  });

  const writeSheet = useMutation({
    mutationFn: (path: string) =>
      api.post<{ created: number; updated: number; bad: number }>('/api/products/sheet-import', {
        path,
      }),
    onSuccess: (r) => {
      setSheet(null);
      setFlash(
        `新建 ${r.created} 个商品，改了 ${r.updated} 个` + (r.bad ? `，${r.bad} 行没看懂` : ''),
      );
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['stockOverview'] });
    },
    onError: (e) => {
      setSheet(null);
      setFlash((e as Error).message);
    },
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
          onClick={() => void exportXlsx('products')}
          className="h-12 rounded-[10px] border border-line bg-card px-5 text-[17px]"
        >
          导出 Excel
        </button>
        {/* 导出那份表改完就从这儿导回来：加商品、填价、改单位，一张表全解决 */}
        <button
          type="button"
          onClick={() => pickSheet.mutate()}
          disabled={pickSheet.isPending}
          className="h-12 rounded-[10px] border border-line bg-card px-5 text-[17px] disabled:opacity-60"
        >
          {pickSheet.isPending ? '读取中…' : '导入 Excel'}
        </button>
      </div>

      <Flash value={flash} className="shrink-0" />

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
            <span className="w-16" />
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
                <button
                  type="button"
                  onClick={() => setDoomed(p)}
                  aria-label={`删除 ${p.name}`}
                  className="h-11 w-16 rounded-[10px] text-[17px] text-muted hover:bg-danger-50 hover:text-danger"
                >
                  删除
                </button>
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
            一行一个，两种写法：
            <br />
            <span className="num">名称 - 单位</span>　或
            <span className="num">名称 - 大单位 - N小单位</span>
            <br />
            {/* 店里的清单多半是「名称 - 单位 - 价格」，不先说一句，粘进来一半行都报错 */}
            价格<span className="text-ink-2">不要</span>写在第三段 —— 那一段是换算（
            <span className="num">10包</span>）。
          </div>

          <div className="mt-4 mb-3 text-[17px] font-semibold">③ Excel 改完导回来</div>
          <div className="text-[15px] leading-relaxed text-muted">
            上面「导出 Excel」那份就是模板：在 Excel 里加商品、填价格、改品牌规格单位，
            存好再点「导入 Excel」。一张表改几十行，比在这儿一个个点快得多。
            <br />
            已经有进货或销售记录的商品，<span className="text-ink-2">单位和换算改不动</span> ——
            改了历史上每一笔的数量含义都会跟着变。
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
            ④ 卖货时搜不到的商品，回车就地建，不耽误这笔生意。
            <br />
            商品库是用出来的，不是录出来的。
          </div>
        </Card>
      </div>

      {/* 删之前问一句。这是商品页唯一一个会让东西消失的按钮，手滑的代价比多点一下大 */}
      {/* 这张表能建商品也能改价，导之前必须让他看见会发生什么 */}
      <Modal open={!!sheet} onClose={() => setSheet(null)} title="这张表要写进去">
        <div className="mb-1 num text-[17px] text-ink-2">{sheet?.file}</div>
        <div className="mb-4 text-[19px]">
          新建 <span className="num font-semibold">{sheet?.create ?? 0}</span> 个　改{' '}
          <span className="num font-semibold">{sheet?.update ?? 0}</span> 个
          <span className="text-muted">
            　没变 {sheet?.same ?? 0}
            {(sheet?.bad ?? 0) > 0 && `　没看懂 ${sheet?.bad}`}
          </span>
        </div>

        <div className="max-h-[320px] overflow-auto rounded-xl border border-line">
          {sheet?.rows.map((r) => (
            <div key={r.rowNo} className="border-b border-line px-4 py-2.5 last:border-b-0">
              <div className="flex items-baseline gap-2.5">
                <span className="num text-[14px] text-muted">第 {r.rowNo} 行</span>
                <span className="text-[18px]">{r.name}</span>
                {r.outcome === 'create' && (
                  <span className="rounded-md bg-brand-50 px-2 py-0.5 text-[13px] text-brand-900">
                    新建
                  </span>
                )}
              </div>
              {r.outcome === 'bad' ? (
                <div className="text-[16px] text-danger">{r.reason}</div>
              ) : (
                r.changes.map((c) => (
                  <div key={c} className="num text-[16px] text-brand-900">
                    {c}
                  </div>
                ))
              )}
              {/* 没照做的部分要说，不然他以为改了 */}
              {r.notes.map((n) => (
                <div key={n} className="text-[15px] text-danger">
                  {n}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="mt-4 text-[16px] leading-relaxed text-muted">
          留空的格子不动库里的值。「当前库存」「加权成本」两列是算出来的，改了不生效。
          <br />
          表里删掉一行不会停用那个商品 —— 停用请用列表里的「删除」。
        </div>

        <div className="mt-6 flex justify-end gap-3">
          {/* 焦点默认落在「不导了」：这个框里回车最该做的事是什么都不做 */}
          <button
            type="button"
            autoFocus
            onClick={() => setSheet(null)}
            className="h-13 rounded-[10px] border border-line bg-card px-5 text-[18px]"
          >
            不导了
          </button>
          <button
            type="button"
            onClick={() => sheet?.path && writeSheet.mutate(sheet.path)}
            disabled={
              writeSheet.isPending || ((sheet?.create ?? 0) === 0 && (sheet?.update ?? 0) === 0)
            }
            className="h-13 rounded-[10px] bg-brand-700 px-6 text-[18px] font-semibold text-white disabled:opacity-60"
          >
            {writeSheet.isPending
              ? '写入中…'
              : `写进去（${(sheet?.create ?? 0) + (sheet?.update ?? 0)}）`}
          </button>
        </div>
      </Modal>

      <Modal open={!!doomed} onClose={() => setDoomed(null)} title="删掉这个商品？">
        <div className="mb-2 text-[21px] font-semibold">{doomed?.name}</div>
        <div className="text-[17px] leading-relaxed text-ink-2">
          没进过货也没卖过的，直接删掉，库里不留。
          <br />
          已经有账的删不掉 —— 老单据还指着它，删了上个月的账就看不懂了。
          这种会改成停用：列表和搜索里不再出现，老账照样查得到。
        </div>
        <div className="mt-6 flex justify-end gap-3">
          {/* 焦点默认落在「不删了」：这个框里回车最该做的事是什么都不做 */}
          <button
            type="button"
            autoFocus
            onClick={() => setDoomed(null)}
            className="h-13 rounded-[10px] border border-line bg-card px-5 text-[18px]"
          >
            不删了
          </button>
          <button
            type="button"
            onClick={() => doomed && remove.mutate(doomed.id)}
            disabled={remove.isPending}
            className="h-13 rounded-[10px] bg-danger px-6 text-[18px] font-semibold text-white disabled:opacity-60"
          >
            删掉
          </button>
        </div>
      </Modal>
    </div>
  );
}
