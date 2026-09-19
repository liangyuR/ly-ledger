import { Pending } from '../components/Card';

export default function Sell() {
  return (
    <Pending
      title="卖货"
      milestone="M4 实现"
      items={[
        '搜索框拼音三路匹配，↑↓ 选择、回车加入',
        '常用商品 12 格，数字键直选',
        '抹零框 —— 输的是让掉的钱，不改单价',
        'F8 现金收讫一键完成 · F9 挂账 · F7 部分付',
      ]}
    />
  );
}
