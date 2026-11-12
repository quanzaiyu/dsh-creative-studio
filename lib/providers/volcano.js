/**
 * 火山引擎适配器（豆包大模型方舟 Ark + 豆包语音）。
 *
 * 图/视频走方舟 https://ark.cn-beijing.volces.com/api/v3（Bearer ARK_API_KEY）；
 * 配音走豆包语音 https://openspeech.bytedance.com/api/v3/tts/create
 * （X-Api-Key: VOLCANO_SPEECH_API_KEY，与方舟是两把不同的钥匙）。
 * 音乐无公开 API。
 */

const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3'
const SPEECH_BASE = 'https://openspeech.bytedance.com'
const POLL_INTERVAL_MS = 4000
const VIDEO_TIMEOUT_MS = 900_000

async function arkJson(url, init, key, signal) {
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
    throw new Error(`火山方舟 API ${response.status}: ${String(detail).slice(0, 400)}`)
  }
  return body
}

/** 生图（同步，OpenAI 兼容）。 */
async function generateImage({ model, prompt, refs, options, key, baseUrl, signal }) {
  const body = { model, prompt, response_format: 'url', watermark: options.watermark === 'true' }
  const images = refs.filter((r) => r.kind === 'image').map((r) => r.dataUri)
  if (images.length > 0) body.image = images
  const size = typeof options.size === 'string' ? options.size.trim() : ''
  if (/^\d{3,4}x\d{3,4}$/.test(size) || ['1K', '2K', '4K'].includes(size)) body.size = size
  const payload = await arkJson(`${baseUrl}/images/generations`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, key, signal)
  const item = (payload?.data ?? [])[0]
  if (item === undefined) throw new Error('火山生图未返回数据')
  if (typeof item.url === 'string' && item.url.length > 0) return { url: item.url, mime: 'image/jpeg' }
  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
    return { bytes: new Uint8Array(Buffer.from(item.b64_json, 'base64')), mime: 'image/jpeg' }
  }
  throw new Error('火山生图响应中既无 url 也无 b64_json')
}

/** 生视频（异步任务 + 轮询）。 */
async function generateVideo({ model, prompt, refs, options, key, baseUrl, signal }) {
  const content = [{ type: 'text', text: prompt }]
  for (const r of refs) {
    if (r.kind === 'image') content.push({ type: 'image_url', image_url: { url: r.dataUri }, role: 'reference_image' })
    else if (r.kind === 'video') content.push({ type: 'video_url', video_url: { url: r.dataUri }, role: 'reference_video' })
    else if (r.kind === 'audio') content.push({ type: 'audio_url', audio_url: { url: r.dataUri }, role: 'reference_audio' })
  }
  const body = { model, content, watermark: options.watermark === 'true' }
  const ratios = ['16:9', '9:16', '1:1', '4:3', '21:9', 'adaptive']
  if (ratios.includes(options.ratio)) body.ratio = options.ratio
  const duration = Number(options.duration)
  if (Number.isFinite(duration) && duration >= 4 && duration <= 30) body.duration = Math.round(duration)
  if (options.generateAudio === 'true') body.generate_audio = true
  const created = await arkJson(`${baseUrl}/contents/generations/tasks`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, key, signal)
  const taskId = created?.id
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('火山生视频未返回任务 id：' + JSON.stringify(created).slice(0, 300))
  }
  const deadline = Date.now() + VIDEO_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const status = await arkJson(`${baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`, { method: 'GET' }, key, signal)
    const state = status?.status
    if (state === 'succeeded') {
      const url = status?.content?.video_url
      if (typeof url !== 'string' || url.length === 0) throw new Error('火山视频任务成功但没有 video_url')
      return { url, mime: 'video/mp4', meta: { taskId } }
    }
    if (state === 'failed' || state === 'cancelled') {
      throw new Error(`火山视频任务失败（${state}）：${String(status?.error?.message ?? '未知原因').slice(0, 300)}`)
    }
  }
  throw new Error('火山视频生成轮询超时')
}

/** 配音（豆包语音 seed-audio-1.0，X-Api-Key 鉴权；支持参考音频定音色）。 */
async function generateTts({ prompt, refs, options, key, baseUrl, signal }) {
  const formats = ['mp3', 'wav']
  const format = formats.includes(options.format) ? options.format : 'mp3'
  const sampleRates = [16000, 24000, 32000, 48000]
  const sampleRate = sampleRates.includes(Number(options.sampleRate)) ? Number(options.sampleRate) : 24000
  const body = {
    model: 'seed-audio-1.0',
    text_prompt: prompt,
    references: [],
    audio_config: { format, sample_rate: sampleRate },
  }
  const speaker = typeof options.speaker === 'string' ? options.speaker.trim() : ''
  const refAudio = refs.find((r) => r.kind === 'audio')
  if (speaker.length > 0) body.references.push({ speaker })
  if (refAudio !== undefined) {
    const entry = body.references.find((x) => x.speaker !== undefined) ?? body.references[body.references.push({}) - 1]
    entry.audio = refAudio.dataUri
  }
  const response = await fetch(`${SPEECH_BASE}/api/v3/tts/create`, {
    method: 'POST',
    signal,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`火山语音 API ${response.status}: ${text.slice(0, 300)}`)
  }
  if (contentType.startsWith('audio/')) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { bytes, mime: contentType.split(';')[0] }
  }
  const text = await response.text()
  let payload
  try { payload = JSON.parse(text) } catch { payload = undefined }
  const b64 = payload?.audio ?? payload?.data?.audio
  if (typeof b64 === 'string' && b64.length > 0) {
    return { bytes: new Uint8Array(Buffer.from(b64, 'base64')), mime: format === 'wav' ? 'audio/wav' : 'audio/mpeg' }
  }
  const url = payload?.url ?? payload?.data?.url ?? payload?.audio_url
  if (typeof url === 'string' && url.length > 0) return { url, mime: format === 'wav' ? 'audio/wav' : 'audio/mpeg' }
  throw new Error('火山语音未返回可识别的音频：' + text.slice(0, 300))
}

export default {
  id: 'volcano',
  name: '火山引擎',
  keyRef: 'ARK_API_KEY',
  extraKeyRefs: [{ ref: 'VOLCANO_SPEECH_API_KEY', label: '语音 API Key（X-Api-Key，与方舟 Key 不同）' }],
  defaultBaseUrl: ARK_BASE,
  baseUrlEditable: true,
  docs: 'https://www.volcengine.com/docs/ark',
  capabilities: {
    image: {
      models: [
        { id: 'doubao-seedream-4-0-250828', name: '豆包 Seedream 4.0（推荐）' },
        { id: 'doubao-seedream-3-0-t2i-250415', name: '豆包 Seedream 3.0 文生图' },
      ],
      options: [
        { id: 'size', label: '尺寸（4.0 用 1K/2K/4K，3.0 用 像素宽x高）', type: 'text', default: '2K', placeholder: '2K 或 1024x1024' },
        { id: 'watermark', label: 'AI 生成水印', type: 'select', default: 'false', choices: ['false', 'true'] },
      ],
      refs: { image: 4 },
      refNote: '参考图（URL/base64）参与图生图/编辑，写在提示词里描述改法。',
      generate: generateImage,
    },
    video: {
      models: [
        { id: 'doubao-seedance-2-5-260628', name: '豆包 Seedance 2.5（推荐，支持多模态参考）' },
        { id: 'doubao-seedance-1-0-pro', name: '豆包 Seedance 1.0 Pro' },
        { id: 'doubao-seedance-1-0-lite', name: '豆包 Seedance 1.0 Lite' },
      ],
      options: [
        { id: 'duration', label: '时长（4~30 秒）', type: 'text', default: '5', placeholder: '5' },
        { id: 'ratio', label: '画幅', type: 'select', default: '16:9', choices: ['16:9', '9:16', '1:1', '4:3', '21:9'] },
        { id: 'generateAudio', label: '同步生成音轨（Seedance 2.5）', type: 'select', default: 'false', choices: ['false', 'true'] },
        { id: 'watermark', label: '水印', type: 'select', default: 'false', choices: ['false', 'true'] },
      ],
      refs: { image: 10, video: 5, audio: 5 },
      refNote: 'Seedance 2.5 最多 10 图 + 5 视频 + 5 音频参考；参考素材经 base64 data URI 传入。',
      generate: generateVideo,
    },
    tts: {
      keyRef: 'VOLCANO_SPEECH_API_KEY',
      models: [
        { id: 'seed-audio-1.0', name: 'seed-audio-1.0（豆包音频生成 1.0）' },
      ],
      options: [
        { id: 'speaker', label: '音色 ID（可选，配合参考音频）', type: 'text', default: '', placeholder: '豆包语音 2.0 音色或复刻音色 ID' },
        { id: 'format', label: '格式', type: 'select', default: 'mp3', choices: ['mp3', 'wav'] },
        { id: 'sampleRate', label: '采样率', type: 'select', default: '24000', choices: ['16000', '24000', '32000', '48000'] },
      ],
      refs: { audio: 1 },
      refNote: '可上传参考音频定制音色；也可只填音色 ID。使用独立的“语音 API Key”（X-Api-Key）。',
      generate: generateTts,
    },
  },
}
