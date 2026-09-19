/** 必须最先执行：index.ts 用 `import './env'` 放在首行。 */
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(__dirname, '..', '.env');

if (existsSync(envPath)) {
  config({ path: envPath });
}
