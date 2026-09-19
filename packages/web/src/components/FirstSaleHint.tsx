/**
 * 卖货页上的第一笔提示。
 *
 * 向导的第四步不在向导里做 —— 是把人送到这里，用真商品卖一笔真的。
 * 所以提示必须长在卖货页上，且卖成第一笔就自己消失。
 */
import { useOnboarding } from '../hooks/useOnboarding';

export default function FirstSaleHint() {
  const state = useOnboarding();
  const d = state.data;
  if (!d || d.dismissed) return null;

  const sold = d.steps.find((s) => s.key === 'firstSale')?.done;
  if (sold) return null;

  return (
    <div className="shrink-0 rounded-2xl bg-brand-50 px-7 py-5 text-[19px] leading-relaxed text-brand-900">
      <strong className="font-semibold">卖第一笔：</strong>
      在下面搜商品名的拼音首字母（中华就敲 <span className="num font-semibold">zh</span>），回车选中，
      再回车加入，然后按 <span className="num font-semibold">F8</span> 收钱。
      <span className="ml-2 text-[17px]">卖成这一笔，这条提示就没了。</span>
    </div>
  );
}
