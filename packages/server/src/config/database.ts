import type { IDatabaseOptions } from '@nocobase/database';

/**
 * SQLite 在 NocoBase 2.x 里仍是注册过的一等方言（@nocobase/database
 * 的 registerDialects 与 mysql/postgres 并列），只是 create-nocobase-app
 * 的 -d 选项没把它列出来，需要自己配。
 */
export default {
  logging: process.env.DB_LOGGING === 'on' ? console.log : false,
  dialect: process.env.DB_DIALECT as any,
  storage: process.env.DB_STORAGE,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT as any,
  timezone: process.env.DB_TIMEZONE,
  tablePrefix: process.env.DB_TABLE_PREFIX,
  underscored: process.env.DB_UNDERSCORED === 'true',
} as IDatabaseOptions;
