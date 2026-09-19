import { Pending } from '../components/Card';

export default function Purchase() {
  return (
    <Pending
      title="进货"
      milestone="M4 实现"
      items={[
        '选供应商、填进价（不是售价）',
        '录入后立刻显示新的加权成本，让老板知道成本变了',
        'F8 入库',
      ]}
    />
  );
}
