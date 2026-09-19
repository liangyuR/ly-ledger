/**
 * 看板上的上手清单 —— 全屏向导的降级形态。
 *
 * 老板中途退出向导，进度不能消失，但也不该再霸占整屏。降级成看板顶上
 * 一张卡：做完自动消失，也能主动关掉（docs/04）。
 */
import { useNavigate } from 'react-router-dom';

import { useDismissOnboarding, useOnboarding, type OnboardingStep } from '../hooks/useOnboarding';
import { Card } from './Card';

function Mark({ step }: { step: OnboardingStep }) {
  if (step.done) {
    return (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-700 text-white">
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
      </span>
    );
  }
  // 最后一步是"装好了"的标志，圈画成主色，跟可跳过的那步区分开
  const key = step.key === 'firstSale';
  return (
    <span
      className={`block size-8 shrink-0 rounded-full border-2 ${key ? 'border-brand-700' : 'border-line'}`}
    />
  );
}

export default function OnboardingChecklist() {
  const navigate = useNavigate();
  const state = useOnboarding();
  const dismiss = useDismissOnboarding();

  const d = state.data;
  if (!d || d.complete || d.dismissed) return null;

  return (
    <Card className="shrink-0">
      <div className="mb-2.5 flex items-center gap-3.5">
        <h2 className="m-0 text-[19px] font-semibold">上手清单</h2>
        <span className="num text-[17px] text-brand-900">
          {d.doneCount} / {d.steps.length}
        </span>
        <span className="text-[17px] text-muted">做完就不再出现</span>
        <span className="grow" />
        <button
          type="button"
          onClick={() => navigate('/onboarding')}
          className="h-13 rounded-[11px] border border-brand-700 bg-brand-700 px-6 text-[18px] font-semibold text-white"
        >
          接着弄
        </button>
        <button
          type="button"
          onClick={() => dismiss.mutate(true)}
          className="h-13 rounded-[11px] border border-line bg-card px-5 text-[17px] text-ink-2"
        >
          不用了，关掉
        </button>
      </div>
      {d.steps.map((s) => (
        <div key={s.key} className="flex h-15 items-center gap-4">
          <Mark step={s} />
          <span
            className={`text-[20px] ${s.done ? 'text-ink-2' : s.key === 'firstSale' ? 'font-semibold text-ink' : 'text-ink'}`}
          >
            {s.title}
          </span>
          <span className="text-[16px] text-muted">{s.detail}</span>
        </div>
      ))}
    </Card>
  );
}
