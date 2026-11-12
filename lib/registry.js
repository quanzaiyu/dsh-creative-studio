/**
 * 供应商注册中心。
 *
 * 每个适配器形如：
 * {
 *   id, name, keyRef, defaultBaseUrl,
 *   capabilities: {
 *     image?: {
 *       models: [{id, name}],
 *       options?: [{id, label, type:'select'|'text'|'number', choices?, default, placeholder?, min?, max?}],
 *       refs?: {image?:number, video?:number, audio?:number},   // 支持的参考素材数量上限
 *       refNote?: string,                                        // 参考素材说明（展示给用户）
 *       generate: async ({model, prompt, negativePrompt, refs, options, key, baseUrl, signal}) =>
 *         ({bytes?, mime, url?, meta?})
 *     },
 *     video?: {...}, music?: {...}, tts?: {...}
 *   }
 * }
 *
 * refs 元素形如 {kind:'image'|'video'|'audio', name, mime, dataUri}。
 * 适配器返回 bytes（优先）或 url；host 负责下载与落盘。
 */

import bailian from './providers/bailian.js'
import moss from './providers/moss.js'
import agnes from './providers/agnes.js'
import minimax from './providers/minimax.js'
import volcano from './providers/volcano.js'

export const PROVIDERS = [moss, minimax, bailian, agnes, volcano]

/** @param {string} id */
export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id)
}

/** 全部支持的能力。 */
export const CAPABILITIES = ['image', 'video', 'music', 'tts']

/** 能力的中文名。 */
export const CAPABILITY_LABELS = { image: '生图', video: '生视频', music: '音乐', tts: '配音' }
