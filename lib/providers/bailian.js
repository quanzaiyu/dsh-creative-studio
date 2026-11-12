/**
 * 阿里云百炼（DashScope）适配器。
 *
 * 规格来源：help.aliyun.com/zh/model-studio（text-to-image / wan3-video /
 * non-realtime-tts / fun-music）。鉴权统一 Bearer DASHSCOPE_API_KEY；
 * 生图与生视频为异步任务（X-DashScope-Async: enable + GET /api/v1/tasks/{id}）；
 * 音乐与 TTS 为同步接口，返回音频 URL（24h 有效），由 host 下载落盘。
 */

const DEFAULT_BASE = 'https://dashscope.aliyuncs.com'

/** 轮询间隔与上限。 */
const POLL_INTERVAL_MS = 3000
const IMAGE_TIMEOUT_MS = 180_000
const VIDEO_TIMEOUT_MS = 900_000

/** 供应商级共享请求函数。 */
async function apiFetch(url, init, key, signal) {
  const response = await fetch(url, {
    ...init,
    signal,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body
  try { body = text.length > 0 ? JSON.parse(text) : undefined } catch { body = undefined }
  if (!response.ok) {
    const detail = body?.message ?? body?.error?.message ?? text ?? response.statusText
    throw new Error(`百炼 API ${response.status}: ${String(detail).slice(0, 400)}`)
  }
  return body
}

/** 提交异步任务并轮询至完成，返回任务输出。 */
async function submitAndPoll(baseUrl, path, body, key, signal, timeoutMs) {
  const created = await apiFetch(`${baseUrl}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'X-DashScope-Async': 'enable' },
  }, key, signal)
  const taskId = created?.output?.task_id
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('百炼未返回 task_id：' + JSON.stringify(created).slice(0, 300))
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const status = await apiFetch(`${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'GET' }, key, signal)
    const output = status?.output ?? {}
    const state = output.task_status
    if (state === 'SUCCEEDED') return output
    if (state === 'FAILED' || state === 'CANCELED' || state === 'UNKNOWN') {
      throw new Error(`百炼任务失败（${state}）：${String(output.message ?? output.code ?? '未知原因').slice(0, 300)}`)
    }
  }
  throw new Error('百炼任务轮询超时')
}

/** 从同步响应中取音频 URL。 */
function audioUrlOf(payload, label) {
  const url = payload?.output?.audio?.url
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`百炼 ${label} 未返回音频 URL：${JSON.stringify(payload).slice(0, 300)}`)
  }
  return url
}

/** 生图。 */
async function generateImage({ model, prompt, negativePrompt, options, key, baseUrl, signal }) {
  const size = typeof options.size === 'string' && options.size.length > 0 ? options.size : '1280*1280'
  let result
  if (model === 'wanx-v1') {
    const input = { prompt }
    if (negativePrompt.length > 0) input.negative_prompt = negativePrompt
    result = await submitAndPoll(baseUrl, '/api/v1/services/aigc/text2image/image-synthesis', {
      model,
      input,
      parameters: { size, n: 1 },
    }, key, signal, IMAGE_TIMEOUT_MS)
  } else {
    const message = { role: 'user', content: [{ text: prompt }] }
    if (negativePrompt.length > 0) message.content.push({ text: negativePrompt, role: 'negative' })
    result = await submitAndPoll(baseUrl, '/api/v1/services/aigc/multimodal-generation/generation', {
      model,
      input: { messages: [message] },
      parameters: { size, n: 1, prompt_extend: options.promptExtend === true },
    }, key, signal, IMAGE_TIMEOUT_MS)
  }
  const url = result?.results?.[0]?.url
  if (typeof url !== 'string' || url.length === 0) throw new Error('百炼生图未返回结果 URL')
  return { url, mime: 'image/png', meta: { taskId: result.task_id } }
}

/** 生视频。 */
async function generateVideo({ model, prompt, refs, options, key, baseUrl, signal }) {
  const media = []
  const firstImage = refs.find((r) => r.kind === 'image')
  if (firstImage !== undefined) media.push({ type: 'first_frame', url: firstImage.dataUri })
  const parameters = {
    resolution: ['480P', '720P', '1080P'].includes(options.resolution) ? options.resolution : '720P',
    ratio: ['adaptive', '16:9', '9:16', '1:1', '4:3'].includes(options.ratio) ? options.ratio : 'adaptive',
    audio: options.audio !== false,
  }
  const duration = Number(options.duration)
  if (Number.isFinite(duration) && (duration === -1 || (duration >= 2 && duration <= 30))) parameters.duration = duration
  const input = { prompt }
  if (media.length > 0) input.media = media
  const output = await submitAndPoll(baseUrl, '/api/v1/services/aigc/video-generation/video-synthesis', {
    model, input, parameters,
  }, key, signal, VIDEO_TIMEOUT_MS)
  const url = output?.video_url
  if (typeof url !== 'string' || url.length === 0) throw new Error('百炼生视频未返回 video_url')
  return { url, mime: 'video/mp4', meta: { taskId: output.task_id } }
}

/** 音乐。 */
async function generateMusic({ model, prompt, options, key, baseUrl, signal }) {
  const input = {}
  if (typeof options.lyrics === 'string' && options.lyrics.trim().length > 0) input.lyrics = options.lyrics.trim()
  if (input.lyrics === undefined && prompt.length === 0) throw new Error('音乐生成需要提示词或歌词至少其一')
  if (prompt.length > 0) input.prompt = prompt
  if (model === 'fun-music-v1' && (options.gender === 'male' || options.gender === 'female')) input.gender = options.gender
  const payload = await apiFetch(`${baseUrl}/api/v1/services/audio/music/generation`, {
    method: 'POST',
    body: JSON.stringify({ model, input }),
  }, key, signal)
  return { url: audioUrlOf(payload, '音乐'), mime: 'audio/mpeg' }
}

/** 配音（TTS）。 */
async function generateTts({ model, prompt, options, key, baseUrl, signal }) {
  const voice = typeof options.voice === 'string' && options.voice.trim().length > 0 ? options.voice.trim() : 'longanyang'
  const format = ['mp3', 'wav'].includes(options.format) ? options.format : 'mp3'
  const sampleRate = [8000, 16000, 22050, 24000, 48000].includes(Number(options.sampleRate)) ? Number(options.sampleRate) : 24000
  const payload = await apiFetch(`${baseUrl}/api/v1/services/audio/tts/SpeechSynthesizer`, {
    method: 'POST',
    body: JSON.stringify({
      model,
      input: { text: prompt, voice, format, sample_rate: sampleRate },
    }),
  }, key, signal)
  return { url: audioUrlOf(payload, 'TTS'), mime: format === 'wav' ? 'audio/wav' : 'audio/mpeg' }
}

export default {
  id: 'bailian',
  name: '阿里云百炼',
  keyRef: 'DASHSCOPE_API_KEY',
  defaultBaseUrl: DEFAULT_BASE,
  baseUrlEditable: true,
  docs: 'https://help.aliyun.com/zh/model-studio/',
  capabilities: {
    image: {
      models: [
        { id: 'wan2.6-t2i', name: '万相 2.6 文生图' },
        { id: 'wan2.5-t2i-preview', name: '万相 2.5 Preview' },
        { id: 'wan2.2-t2i-flash', name: '万相 2.2 极速版' },
        { id: 'wan2.2-t2i-plus', name: '万相 2.2 专业版' },
        { id: 'wanx2.1-t2i-turbo', name: '万相 2.1 极速版' },
        { id: 'wanx-v1', name: '万相 V1' },
      ],
      options: [
        { id: 'size', label: '尺寸', type: 'select', default: '1280*1280', choices: ['1280*1280', '960*1280', '1280*960', '720*1280', '1280*720'] },
        { id: 'promptExtend', label: '提示词自动扩写', type: 'select', default: 'false', choices: ['false', 'true'] },
      ],
      refs: {},
      refNote: '百炼文生图暂不支持直接传本地参考图（垫图需公网 URL），可先用其他能力生成再编辑。',
      generate: generateImage,
    },
    video: {
      models: [
        { id: 'wan3.0-video', name: '万相 3.0 视频生成' },
        { id: 'wan3.0-video-prime', name: '万相 3.0 高速版' },
        { id: 'happyhorse-1.1-t2v', name: '文生视频（有声）' },
        { id: 'happyhorse-1.1-i2v', name: '首帧图生视频' },
        { id: 'happyhorse-1.1-r2v', name: '参考生视频' },
      ],
      options: [
        { id: 'resolution', label: '分辨率', type: 'select', default: '720P', choices: ['480P', '720P', '1080P'] },
        { id: 'ratio', label: '画幅', type: 'select', default: 'adaptive', choices: ['adaptive', '16:9', '9:16', '1:1', '4:3'] },
        { id: 'duration', label: '时长（秒，-1 智能）', type: 'text', default: '5', placeholder: '2~30 或 -1' },
        { id: 'audio', label: '包含音轨', type: 'select', default: 'true', choices: ['true', 'false'] },
      ],
      refs: { image: 1 },
      refNote: '参考图作为视频首帧（first_frame），支持 base64，最多 1 张。',
      generate: generateVideo,
    },
    music: {
      models: [
        { id: 'fun-music-v1', name: 'Fun-Music v1' },
        { id: 'fun-music-preview', name: 'Fun-Music Preview' },
      ],
      options: [
        { id: 'lyrics', label: '歌词（可选，支持 [verse]/[chorus] 段落）', type: 'text', default: '', placeholder: '留空则按提示词纯音乐生成' },
        { id: 'gender', label: '人声', type: 'select', default: 'female', choices: ['female', 'male'] },
      ],
      refs: {},
      refNote: '百炼音乐暂不支持参考音频。',
      generate: generateMusic,
    },
    tts: {
      models: [
        { id: 'qwen-audio-3.1-tts-flash', name: 'Qwen-Audio 3.1 TTS Flash（推荐）' },
        { id: 'qwen-audio-3.1-tts-plus', name: 'Qwen-Audio 3.1 TTS Plus' },
        { id: 'cosyvoice-v3.5-flash', name: 'CosyVoice 3.5 Flash' },
        { id: 'cosyvoice-v3-flash', name: 'CosyVoice v3 Flash' },
        { id: 'qwen3-tts-flash', name: 'Qwen3 TTS Flash' },
      ],
      options: [
        { id: 'voice', label: '音色', type: 'text', default: 'longanyang', placeholder: '如 longanyang / longanhuan_v3.1' },
        { id: 'format', label: '格式', type: 'select', default: 'mp3', choices: ['mp3', 'wav'] },
        { id: 'sampleRate', label: '采样率', type: 'select', default: '24000', choices: ['16000', '22050', '24000', '48000'] },
      ],
      refs: {},
      refNote: '百炼 TTS 使用预置/复刻音色 ID，暂不支持直接传参考音频。',
      generate: generateTts,
    },
  },
}
