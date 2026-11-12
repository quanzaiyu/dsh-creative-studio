/**
 * MOSS 开放平台适配器（https://platform.moss.cn，网关 https://api.mosi.cn）。
 *
 * 能力：生图（/v1/images/generations，同步返回 URL）、配音 TTS
 * （/v1/audio/speech 同步返回音频二进制；moss-voice-generator-1.0 走
 * /v1/audio/voice/generations）。传参考音频时先经 /v1/audio/voices
 * （multipart）克隆音色，再以返回的 voice_id 合成。
 * 该平台无生视频与音乐生成 API。
 */

const DEFAULT_BASE = 'https://api.mosi.cn'

async function apiJson(url, init, key, signal) {
  const response = await fetch(url, {
    ...init,
    signal,
    headers: { 'Authorization': `Bearer ${key}`, ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body
  try { body = text.length > 0 ? JSON.parse(text) : undefined } catch { body = undefined }
  if (!response.ok) {
    const detail = body?.error?.message ?? body?.message ?? text ?? response.statusText
    throw new Error(`MOSS API ${response.status}: ${String(detail).slice(0, 400)}`)
  }
  return body
}

/** 用参考音频克隆音色，返回 voice_id。 */
async function cloneVoice(refAudio, key, baseUrl, signal) {
  const form = new FormData()
  form.append('name', `studio-voice-${Date.now()}`)
  form.append('audio_sample', new Blob([refAudio.bytes], { type: refAudio.mime || 'audio/wav' }), refAudio.name || 'ref.wav')
  const payload = await apiJson(`${baseUrl}/v1/audio/voices`, { method: 'POST', body: form }, key, signal)
  const voiceId = payload?.id
  if (typeof voiceId !== 'string' || voiceId.length === 0) {
    throw new Error('MOSS 音色克隆未返回 voice_id：' + JSON.stringify(payload).slice(0, 300))
  }
  return voiceId
}

/** 生图。 */
async function generateImage({ model, prompt, negativePrompt, options, key, baseUrl, signal }) {
  const size = typeof options.size === 'string' && /^\d{3,4}x\d{3,4}$/.test(options.size.trim()) ? options.size.trim() : '1024x1024'
  const body = {
    model,
    prompt,
    size,
    response_format: 'url',
    output_watermark: { enabled: options.watermark === 'true' },
  }
  if (negativePrompt.length > 0) body.negative_prompt = negativePrompt
  if (options.promptEnhance === 'true') body.prompt_enhance = true
  const payload = await apiJson(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }, key, signal)
  const url = payload?.data?.[0]?.url
  if (typeof url !== 'string' || url.length === 0) throw new Error('MOSS 生图未返回图片 URL')
  return { url, mime: 'image/png' }
}

/** 配音。 */
async function generateTts({ model, prompt, refs, options, key, baseUrl, signal }) {
  const refAudio = refs.find((r) => r.kind === 'audio')
  let voiceId = typeof options.voiceId === 'string' ? options.voiceId.trim() : ''

  if (model === 'moss-voice-generator-1.0') {
    const instruction = typeof options.instruction === 'string' ? options.instruction.trim() : ''
    if (instruction.length === 0) throw new Error('moss-voice-generator-1.0 需要填写“声音指令”（如：年轻女性、温柔、语速稍慢）')
    const body = {
      model,
      input: prompt,
      instruction,
      response_format: 'mp3',
      delivery_method: 'audio',
    }
    const response = await fetch(`${baseUrl}/v1/audio/voice/generations`, {
      method: 'POST',
      signal,
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`MOSS API ${response.status}: ${text.slice(0, 300)}`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { bytes, mime: response.headers.get('content-type')?.split(';')[0] ?? 'audio/mpeg' }
  }

  // 常规 TTS：voice_id 必填；未填且有参考音频 → 先克隆
  if (voiceId.length === 0 && refAudio !== undefined) {
    voiceId = await cloneVoice(refAudio, key, baseUrl, signal)
  }
  if (voiceId.length === 0) {
    throw new Error('MOSS TTS 需要音色：请填写 voice_id，或上传一段参考音频（≤30s）自动克隆音色。')
  }
  const body = {
    model,
    input: prompt,
    voice_id: voiceId,
    response_format: ['mp3', 'wav'].includes(options.format) ? options.format : 'mp3',
    delivery_method: 'audio',
  }
  if (typeof options.language === 'string' && options.language.trim().length > 0) body.language = options.language.trim()
  const response = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: 'POST',
    signal,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text()
    let detail = text
    try { detail = JSON.parse(text)?.error?.message ?? text } catch {}
    throw new Error(`MOSS API ${response.status}: ${String(detail).slice(0, 300)}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { bytes, mime: response.headers.get('content-type')?.split(';')[0] ?? 'audio/mpeg' }
}

export default {
  id: 'moss',
  name: 'MOSS',
  keyRef: 'MOSS_API_KEY',
  defaultBaseUrl: DEFAULT_BASE,
  baseUrlEditable: true,
  docs: 'https://platform.moss.cn/docs',
  capabilities: {
    image: {
      models: [
        { id: 'moss-image-base-1.0', name: 'MOSS Image Base 1.0' },
        { id: 'moss-image-sft-1.0', name: 'MOSS Image SFT 1.0' },
      ],
      options: [
        { id: 'size', label: '尺寸（宽x高，16 的倍数，≤2048）', type: 'text', default: '1024x1024', placeholder: '1024x1024' },
        { id: 'promptEnhance', label: '提示词增强（¥0.05/次）', type: 'select', default: 'false', choices: ['false', 'true'] },
        { id: 'watermark', label: '水印', type: 'select', default: 'false', choices: ['false', 'true'] },
      ],
      refs: {},
      refNote: 'MOSS 生图不支持参考图（无图生图接口）。',
      generate: generateImage,
    },
    tts: {
      models: [
        { id: 'moss-tts-1.5-flash', name: 'MOSS TTS 1.5 Flash（推荐，支持停顿标记）' },
        { id: 'moss-tts-1.0-pro', name: 'MOSS TTS 1.0 Pro' },
        { id: 'moss-voice-generator-1.0', name: 'MOSS 声音生成器（文字描述声音）' },
      ],
      options: [
        { id: 'voiceId', label: '音色 voice_id（留空且传参考音频时自动克隆）', type: 'text', default: '', placeholder: '可选' },
        { id: 'instruction', label: '声音指令（仅 voice-generator，必填）', type: 'text', default: '', placeholder: '如：年轻女性，温柔，语速稍慢' },
        { id: 'language', label: '语言（仅 1.5-flash，可选）', type: 'text', default: '', placeholder: '如 Chinese / English' },
        { id: 'format', label: '格式', type: 'select', default: 'mp3', choices: ['mp3', 'wav'] },
      ],
      refs: { audio: 1 },
      refNote: '上传参考音频（≤30s、≤10MB）将自动克隆为音色后合成；或直接填 voice_id。',
      generate: generateTts,
    },
  },
}
