import type { ReactNode } from 'react';

export function Card({
  title,
  extra,
  className = '',
  children,
}: {
  title?: string;
  extra?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`rounded-2xl border border-line bg-card px-8 py-7 ${className}`}>
      {title && (
        <div className="mb-5 flex items-baseline gap-3.5">
          <h2 className="m-0 text-[19px] font-semibold">{title}</h2>
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

/** 关键数字。40–52px，四五十岁看得清 */
export function Figure({
  label,
  value,
  sub,
  tone = 'ink',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'ink' | 'brand' | 'danger';
}) {
  const color = tone === 'brand' ? 'text-brand-900' : tone === 'danger' ? 'text-danger' : 'text-ink';
  return (
    <Card className="grow">
      <div className="mb-3 text-[18px] text-ink-2">{label}</div>
      <div className={`num text-[52px] leading-none font-semibold ${color}`}>{value}</div>
      {sub && <div className="mt-2.5 text-[16px] text-muted">{sub}</div>}
    </Card>
  );
}

/** 还没做的页面：说清楚它在哪个里程碑，不要留空白页 */
export function Pending({ title, milestone, items }: { title: string; milestone: string; items: string[] }) {
  return (
    <Card title={title} extra={<span className="text-[17px] text-muted">{milestone}</span>}>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-[17px] text-ink-2">
        {items.map((t) => (
          <li key={t} className="flex gap-2.5">
            <span className="text-muted">·</span>
            {t}
          </li>
        ))}
      </ul>
    </Card>
  );
}
