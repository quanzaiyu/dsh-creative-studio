/**
 * Agnes AI 适配器（https://agnes-ai.com，网关 https://apihub.agnes-ai.com/v1）。
 *
 * 能力：生图（/images/generations 同步，size 档位 + 多参考图/图像编辑）、
 * 生视频（/videos 异步任务 + 网关根路径 /agnesapi 轮询）。
 * 该平台无音乐与 TTS 公开 API。
 */

const DEFAULT_BASE = 'https://apihub.agnes-ai.com/v1'
const POLL_INTERVAL_MS = 4000
const VIDEO_TIMEOUT_MS = 600_000

async function apiJson(url, init, key, signal) {
  const response = await fetch(url, {
    ...init,
    signal,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body
  try { body = text.length > 0 ? JSON.parse(text) : undefined } catch { body = undefined }
  if (!response.ok) {
    const detail = body?.error?.message ?? body?.message ?? text ?? response.statusText
    throw new Error(`Agnes API ${response.status}: ${String(detail).slice(0, 400)}`)
  }
  return body
}

/** 生图（含图生图/编辑：extra_body.image 传参考图）。 */
async function generateImage({ model, prompt, negativePrompt, refs, options, key, baseUrl, signal }) {
  const sizes = ['1K', '2K', '3K', '4K']
  const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '2:3', '3:2']
  const size = sizes.includes(options.size) ? options.size : '2K'
  const ratio = ratios.includes(options.ratio) ? options.ratio : '16:9'
  const body = { model, prompt, size, ratio, extra_body: { response_format: 'url' } }
  const images = refs.filter((r) => r.kind === 'image').map((r) => r.dataUri)
  if (images.length > 0) body.extra_body.image = images
  if (negativePrompt.length > 0) body.negative_prompt = negativePrompt
  const payload = await apiJson(`${baseUrl}/images/generations`, { method: 'POST', body: JSON.stringify(body) }, key, signal)
  const item = payload?.data?.[0]
  if (item === undefined) throw new Error('Agnes 未返回图片数据')
  if (typeof item.url === 'string' && item.url.length > 0) return { url: item.url, mime: 'image/png' }
  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
    return { bytes: new Uint8Array(Buffer.from(item.b64_json, 'base64')), mime: 'image/png' }
  }
  throw new Error('Agnes 生图响应中既无 url 也无 b64_json')
}

/** 生视频（异步任务 + /agnesapi 轮询）。 */
async function generateVideo({ model, prompt, refs, options, key, baseUrl, signal }) {
  const seconds = ['4', '5', '8', '12'].includes(String(options.seconds)) ? String(options.seconds) : '5'
  const sizes = ['720P', '1080P', '1K', '2K']
  const ratios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
  const size = sizes.includes(options.size) ? options.size : '720P'
  const aspect = ratios.includes(options.ratio) ? options.ratio : '16:9'
  const images = refs.filter((r) => r.kind === 'image').map((r) => r.dataUri)
  const body = {
    model,
    prompt,
    mode: images.length > 0 ? 'reference' : 'text',
    seconds,
    size,
    aspect_ratio: aspect,
  }
  if (images.length > 0) body.images = images
  const created = await apiJson(`${baseUrl}/videos`, { method: 'POST', body: JSON.stringify(body) }, key, signal)
  const videoId = created?.video_id ?? created?.id ?? created?.task_id
  if (typeof videoId !== 'string' || videoId.length === 0) {
    throw new Error('Agnes 生视频未返回任务 id：' + JSON.stringify(created).slice(0, 300))
  }
  const origin = new URL(baseUrl).origin
  const query = `video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(model)}`
  const deadline = Date.now() + VIDEO_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const status = await apiJson(`${origin}/agnesapi?${query}`, { method: 'GET' }, key, signal)
    const state = status?.status
    if (state === 'completed') {
      const url = status?.url
      if (typeof url !== 'string' || url.length === 0) throw new Error('Agnes 视频任务完成但没有 url')
      return { url, mime: 'video/mp4', meta: { videoId } }
    }
    if (state === 'failed') {
      throw new Error('Agnes 视频任务失败：' + String(status?.error?.message ?? status?.error ?? '未知原因').slice(0, 300))
    }
  }
  throw new Error('Agnes 视频生成轮询超时')
}

export default {
  id: 'agnes',
  name: 'Agnes',
  keyRef: 'AGNES_API_KEY',
  defaultBaseUrl: DEFAULT_BASE,
  baseUrlEditable: true,
  docs: 'https://agnes-ai.com/zh-Hans/docs/overview',
  capabilities: {
    image: {
      models: [
        { id: 'agnes-image-2.5-flash', name: 'Agnes Image 2.5 Flash（推荐）' },
        { id: 'agnes-image-2.1-flash', name: 'Agnes Image 2.1 Flash' },
        { id: 'agnes-image-2.0-flash', name: 'Agnes Image 2.0 Flash' },
      ],
      options: [
        { id: 'size', label: '清晰度', type: 'select', default: '2K', choices: ['1K', '2K', '3K', '4K'] },
        { id: 'ratio', label: '画幅', type: 'select', default: '16:9', choices: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '2:3', '3:2'] },
      ],
      refs: { image: 4 },
      refNote: '传参考图即变为图生图/图像编辑/多图合成；编辑指令写在提示词里。',
      generate: generateImage,
    },
    video: {
      models: [
        { id: 'agnes-video-2.5', name: 'Agnes Video 2.5（全功能，支持参考）' },
        { id: 'agnes-video-2.5-flash', name: 'Agnes Video 2.5 Flash（快速，720P）' },
      ],
      options: [
        { id: 'seconds', label: '时长（秒）', type: 'select', default: '5', choices: ['4', '5', '8', '12'] },
        { id: 'size', label: '分辨率', type: 'select', default: '720P', choices: ['720P', '1080P', '1K', '2K'] },
        { id: 'ratio', label: '画幅', type: 'select', default: '16:9', choices: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] },
      ],
      refs: { image: 4 },
      refNote: '传参考图进入 reference 模式（图生视频/多图参考）；参考音频/视频暂未接入。',
      generate: generateVideo,
    },
  },
}
