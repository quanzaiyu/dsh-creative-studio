/**
 * 创作展示台（Creative Studio）— host 半区入口。
 *
 * 通过 webServer 注册 /studio 工作台页面、/studio/api/* 接口与资产路由；
 * 生成能力由 lib/providers 下的供应商适配器提供，API Key 存于凭据存储。
 */

import { registerStudio } from './lib/server.js'

export const inject = []

/** @param {object} ctx - cordis 插件上下文 */
export function apply(ctx) {
  return registerStudio(ctx)
}
