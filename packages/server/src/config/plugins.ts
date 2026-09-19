import type { PluginConfiguration } from '@nocobase/server';

/**
 * 显式列出用到的插件，**不用 @nocobase/preset-nocobase**。
 *
 * 两个原因：
 *
 * 1. preset 会把 60 多个插件拖进来（AI、移动端、甘特图、看板、地图、
 *    工作流全家桶……），这些在 01 的"明确不做"清单里，白白撑大便携包。
 *
 * 2. 更要命的是 preset 的依赖树有冲突：`@nocobase/plugin-block-list@2.2.15`
 *    把 `@nocobase/client` 声明成 `1.x`，而同版本其余插件都声明 `2.x`。
 *    npm 为满足它，把 76 个包下沉进 preset 自己的 node_modules，
 *    而 NocoBase 是按顶层 NODE_MODULES_PATH 去 resolve 插件的 ——
 *    于是 plugin-client / ui-layout / flow-engine 全部"查无此包"，
 *    静默跳过，后台界面 404。直接依赖则必然提升到顶层，绕开这个坑。
 *
 * 需要新功能时在这里加，同时加进 package.json 的 dependencies。
 */
export default [
  // —— 基础设施 ——
  'error-handler',
  'data-source-main',
  'data-source-manager',
  'ui-schema-storage',
  'ui-layout',
  'flow-engine',
  'client',
  'localization',

  // —— 认证与权限（后台用；店主侧是无密码自动登录）——
  'acl',
  'auth',
  'users',
  'system-settings',
  'field-sort',

  // —— 业务需要 ——
  'action-export', // Excel 导出
  'action-import', // Excel 导入
  'backups', // M5 备份
  'api-doc', // 开发期查接口
  'api-keys',
] as PluginConfiguration[];
