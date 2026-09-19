import { Pending } from '../components/Card';

export default function Report() {
  return (
    <Pending
      title="报表"
      milestone="M6 实现"
      items={[
        '日 / 月毛利趋势',
        '单品毛利排行',
        '滞销预警与库存金额',
        '导出 Excel',
      ]}
    />
  );
}
