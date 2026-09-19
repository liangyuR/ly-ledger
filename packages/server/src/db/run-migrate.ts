import '../env';
import { migrate } from './migrate';
import { getDb } from './index';

const { applied, skipped } = migrate();

if (applied.length) {
  console.log(`已执行迁移 ${applied.length} 个：${applied.join(', ')}`);
} else {
  console.log(`无新迁移（已有 ${skipped} 个）`);
}

const db = getDb();
const rows = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as { name: string }[];
console.log(`当前表 ${rows.length} 张：${rows.map((r) => r.name).join(', ')}`);
