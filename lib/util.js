/** 通用工具：JSON 请求体解析、响应写出、data URI 处理、文件名生成。 */

/** 请求体大小上限（字节）：64MB，足够多张参考图 + 短参考音视频。 */
export const MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * 读取并解析 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<any>}
 */
export function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error(`请求体超过上限（${Math.round(maxBytes / 1024 / 1024)}MB）`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve(undefined); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/** 写出 JSON 响应。 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** 写出错误 JSON 响应。 */
export function sendError(res, status, message) {
  sendJson(res, status, { error: String(message ?? 'unknown error') })
}

/** 解析 data URI 为 {mime, bytes}。 */
export function parseDataUri(uri) {
  if (typeof uri !== 'string') return undefined
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri)
  if (m === null) return undefined
  const mime = m[1]
  const bytes = m[2] ? new Uint8Array(Buffer.from(m[3], 'base64')) : new TextEncoder().encode(decodeURIComponent(m[3]))
  return { mime, bytes }
}

/** 从 mime 推断扩展名。 */
export function extFromMime(mime, fallback = 'bin') {
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
    'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/opus': 'opus',
  }
  if (typeof mime !== 'string') return fallback
  return map[mime.toLowerCase()] ?? fallback
}

/** 从 URL 推断扩展名（失败回退 mime 推断）。 */
export function extFromUrl(url, mime, fallback = 'bin') {
  try {
    const pathname = new URL(url).pathname
    const m = /\.([a-z0-9]{2,5})$/i.exec(pathname)
    if (m !== null) return m[1].toLowerCase()
  } catch {}
  return extFromMime(mime, fallback)
}

/** 生成带时间戳的输出文件名。 */
export function stampName(kind, provider, ext) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${kind}-${provider}-${stamp}.${ext}`
}

/** 短随机任务 id。 */
export function taskId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36)
}

/** 安全地判断 child 是否位于 parent 目录内。 */
export function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}
