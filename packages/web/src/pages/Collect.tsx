import { Pending } from '../components/Card';

export default function Collect() {
  return (
    <Pending
      title="收款"
      milestone="M4 实现"
      items={[
        '欠款列表按账龄倒序 —— 拖最久的排最前',
        '收款录入，FIFO 自动核销，不让老板选核销哪张单',
        '预收客户灰色、排末尾、不进催收队列',
      ]}
    />
  );
}
