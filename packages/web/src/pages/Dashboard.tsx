import { useQuery } from '@tanstack/react-query';

import { endpoints } from '../api/client';
import { Card, Figure } from '../components/Card';

export default function Dashboard() {
  const health = useQuery({ queryKey: ['health'], queryFn: endpoints.health });
  const products = useQuery({ queryKey: ['products'], queryFn: () => endpoints.products() });

  if (health.isError) {
    return (
      <Card title="连不上后台">
        <p className="m-0 text-[19px] text-danger">{(health.error as Error).message}</p>
        <p className="mt-3 mb-0 text-[17px] text-ink-2">
          开发期先起后端：<code className="num">npm start</code>
        </p>
      </Card>
    );
  }

  return (
    <>
      <div className="flex shrink-0 gap-5">
        <Figure label="今日营业额" value="—" sub="报表接口在 M6" />
        <Figure label="今日毛利" value="—" sub="报表接口在 M6" tone="brand" />
        <Figure label="商品数" value={String(products.data?.items.length ?? 0)} sub="已建档" />
        <Figure
          label="数据表"
          value={String(health.data?.tables ?? 0)}
          sub={`SQLite ${health.data?.sqlite ?? ''}`}
        />
      </div>

      <div className="text-[16px] text-muted">
        毛利 = 售价 − 成本，<strong className="font-semibold text-ink-2">不含房租、水电、人工</strong>
      </div>

      <Card title="后端已就绪的能力" extra={<span className="text-[17px] text-muted">M0 – M2.5</span>}>
        <ul className="m-0 grid list-none grid-cols-2 gap-x-8 gap-y-2.5 p-0 text-[17px] text-ink-2">
          {[
            '卖货结账（现金 / 挂账 / 部分付）',
            '进货入库，移动加权成本',
            '收款与 FIFO 自动核销、预收',
            '改单 / 作废 / 退货',
            '商品批量导入（预置目录 + 手工清单）',
            '拼音三路搜索',
          ].map((t) => (
            <li key={t} className="flex gap-2.5">
              <span className="text-brand-500">✓</span>
              {t}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
