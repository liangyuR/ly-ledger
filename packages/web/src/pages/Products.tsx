import { Pending } from '../components/Card';

export default function Products() {
  return (
    <Pending
      title="商品"
      milestone="M4 实现"
      items={[
        '商品列表，双击格子直接改价',
        '批量导入：粘贴清单 / Excel',
        '按品牌勾选导入预置目录',
      ]}
    />
  );
}
