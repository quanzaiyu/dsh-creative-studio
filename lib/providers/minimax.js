/**
 * MiniMax 适配器（中国站 https://platform.minimax.cn，网关 https://api.minimaxi.com）。
 *
 * 能力：生图（/v1/images/generations 同步）、生视频（/v2/video_generation 异步任务）、
 * 音乐（/v1/music_generation，2026-08 起新用户不可用，保留入口）、配音（/v1/t2a_v2，
 * 返回 hex 编码音频需转二进制）。
 */

const DEFAULT_BASE = 'https://api.minimaxi.com'
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
  const baseResp = body?.base_resp
  if (!response.ok || (baseResp !== undefined && baseResp.status_code !== 0 && baseResp.status_code !== undefined)) {
    const detail = baseResp?.status_msg ?? body?.message ?? text ?? response.statusText
    throw new Error(`MiniMax API ${response.status}: ${String(detail).slice(0, 400)}`)
  }
  return body
}

/** 语音/音乐接口返回的音频字段：hex（官方惯例）或 base64，统一转字节。 */
function decodeAudioField(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const trimmed = value.trim()
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const bytes = Buffer.from(trimmed, 'hex')
    if (bytes.length > 0) return new Uint8Array(bytes)
  }
  try {
    const bytes = Buffer.from(trimmed, 'base64')
    if (bytes.length > 0) return new Uint8Array(bytes)
  } catch {}
  return undefined
}

/** 生图。 */
async function generateImage({ model, prompt, options, key, baseUrl, signal }) {
  const areas = ['1K', '2K', '4K']
  const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']
  const body = {
    model,
    prompt,
    n: 1,
    area: areas.includes(options.area) ? options.area : '2K',
    aspect_ratio: ratios.includes(options.ratio) ? options.ratio : '16:9',
    response_format: 'url',
  }
  const payload = await apiJson(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, key, signal)
  const item = (payload?.data ?? []).find((d) => typeof d?.url === 'string' && d.url.length > 0)
  if (item === undefined) throw new Error('MiniMax 生图未返回可用 URL（可能生成失败或被风控）')
  return { url: item.url, mime: 'image/jpeg', meta: { revisedPrompt: item.revised_prompt ?? null } }
}

/** 生视频（V2 异步任务）。 */
async function generateVideo({ model, prompt, refs, options, key, baseUrl, signal }) {
  const content = [{ type: 'text', text: prompt }]
  const firstImage = refs.find((r) => r.kind === 'image')
  if (firstImage !== undefined) {
    content.push({ type: 'image_url', image_url: { url: firstImage.dataUri }, role: 'first_frame' })
  }
  const duration = Number(options.duration)
  const body = {
    model,
    content,
    duration: Number.isFinite(duration) && duration >= 2 && duration <= 15 ? Math.round(duration) : 6,
    resolution: ['768P', '2K'].includes(options.resolution) ? options.resolution : '768P',
    ratio: ['16:9', '9:16', '1:1', '4:3', '21:9'].includes(options.ratio) ? options.ratio : '16:9',
  }
  const created = await apiJson(`${baseUrl}/v2/video_generation`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, key, signal)
  const taskId = created?.task_id
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('MiniMax 生视频未返回 task_id：' + JSON.stringify(created).slice(0, 300))
  }
  const deadline = Date.now() + VIDEO_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const status = await apiJson(`${baseUrl}/v2/query/video_generation/${encodeURIComponent(taskId)}`, { method: 'GET' }, key, signal)
    const task = status?.task ?? status
    const state = task?.status
    if (state === 'succeeded' || state === 'Success') {
      const url = task?.content?.url ?? task?.file?.download_url ?? task?.file_url
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error('MiniMax 视频任务成功但未取到下载地址：' + JSON.stringify(task).slice(0, 300))
      }
      return { url, mime: 'video/mp4', meta: { taskId } }
    }
    if (state === 'failed' || state === 'Fail' || state === 'cancelled') {
      throw new Error(`MiniMax 视频任务失败（${state}）：${String(task?.message ?? task?.status_msg ?? '未知原因').slice(0, 300)}`)
    }
  }
  throw new Error('MiniMax 视频生成轮询超时')
}

/** 音乐（新用户已下线，历史用户可用）。 */
async function generateMusic({ prompt, options, key, baseUrl, signal }) {
  const body = { model: 'music-01', prompt }
  if (typeof options.lyrics === 'string' && options.lyrics.trim().length > 0) body.lyrics = options.lyrics.trim()
  const payload = await apiJson(`${baseUrl}/v1/music_generation`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, key, signal)
  const bytes = decodeAudioField(payload?.data?.audio)
  if (bytes === undefined) throw new Error('MiniMax 音乐未返回音频数据：' + JSON.stringify(payload).slice(0, 300))
  return { bytes, mime: 'audio/mpeg' }
}

/** 配音 TTS（t2a_v2，hex 音频）。 */
async function generateTts({ model, prompt, options, key, baseUrl, signal }) {
  const formats = ['mp3', 'wav', 'flac', 'pcm']
  const format = formats.includes(options.format) ? options.format : 'mp3'
  const sampleRates = [8000, 16000, 22050, 24000, 32000, 44100, 48000]
  const sampleRate = sampleRates.includes(Number(options.sampleRate)) ? Number(options.sampleRate) : 32000
  const voiceSetting = {
    voice_id: typeof options.voiceId === 'string' && options.voiceId.trim().length > 0 ? options.voiceId.trim() : 'male-qn-qingse',
  }
  const speed = Number(options.speed)
  if (Number.isFinite(speed) && speed >= 0.5 && speed <= 2) voiceSetting.speed = speed
  const emotions = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised']
  if (emotions.includes(options.emotion)) voiceSetting.emotion = options.emotion
  const body = {
    model,
    text: prompt,
    voice_setting: voiceSetting,
    audio_setting: { format, sample_rate: sampleRate, channel: 1 },
    output_format: 'hex',
  }
  const payload = await apiJson(`${baseUrl}/v1/t2a_v2`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, key, signal)
  const bytes = decodeAudioField(payload?.data?.audio)
  if (bytes === undefined) throw new Error('MiniMax TTS 未返回音频数据')
  const mime = format === 'wav' ? 'audio/wav' : format === 'flac' ? 'audio/flac' : format === 'pcm' ? 'audio/pcm' : 'audio/mpeg'
  return { bytes, mime, meta: { usageCharacters: payload?.extra_info?.usage_characters } }
}

export default {
  id: 'minimax',
  name: 'MiniMax',
  keyRef: 'MINIMAX_CN_API_KEY',
  defaultBaseUrl: DEFAULT_BASE,
  baseUrlEditable: true,
  docs: 'https://platform.minimax.cn/docs/api-reference/api-overview',
  capabilities: {
    image: {
      models: [
        { id: 'MiniMax-H3-Image', name: 'MiniMax H3 Image（推荐）' },
        { id: 'MiniMax-H3-Image-Highspeed', name: 'MiniMax H3 Image Highspeed' },
        { id: 'image-01', name: 'image-01（旧接口）' },
      ],
      options: [
        { id: 'area', label: '面积档位', type: 'select', default: '2K', choices: ['1K', '2K', '4K'] },
        { id: 'ratio', label: '画幅', type: 'select', default: '16:9', choices: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] },
      ],
      refs: {},
      refNote: 'MiniMax 参考图编辑走独立的 /v1/images/edits（multipart），本期未接入；生图为纯文生图。',
      generate: generateImage,
    },
    video: {
      models: [
        { id: 'MiniMax-H3', name: 'MiniMax H3（推荐）' },
        { id: 'MiniMax-H3-Highspeed', name: 'MiniMax H3 Highspeed' },
        { id: 'MiniMax-H3-Lite', name: 'MiniMax H3 Lite' },
        { id: 'MiniMax-H3-Max', name: 'MiniMax H3 Max' },
      ],
      options: [
        { id: 'duration', label: '时长（2~15 秒）', type: 'text', default: '6', placeholder: '6' },
        { id: 'resolution', label: '分辨率', type: 'select', default: '768P', choices: ['768P', '2K'] },
        { id: 'ratio', label: '画幅', type: 'select', default: '16:9', choices: ['16:9', '9:16', '1:1', '4:3', '21:9'] },
      ],
      refs: { image: 1 },
      refNote: '参考图作为首帧（first_frame）参与生成。',
      generate: generateVideo,
    },
    music: {
      models: [
        { id: 'music-01', name: 'music-01（注意：2026-08 起新用户不可用）' },
      ],
      options: [
        { id: 'lyrics', label: '歌词（可选，支持 [Verse]/[Chorus]）', type: 'text', default: '', placeholder: '留空则按提示词生成' },
      ],
      refs: {},
      refNote: 'MiniMax 音乐接口已对新用户下线（历史付费用户可用）；新用户建议用百炼音乐。',
      generate: generateMusic,
    },
    tts: {
      models: [
        { id: 'speech-2.8-hd', name: 'speech-2.8-hd（推荐）' },
        { id: 'speech-2.8-turbo', name: 'speech-2.8-turbo' },
        { id: 'speech-02-hd', name: 'speech-02-hd' },
        { id: 'speech-01-turbo', name: 'speech-01-turbo' },
      ],
      options: [
        { id: 'voiceId', label: '音色 voice_id', type: 'text', default: 'male-qn-qingse', placeholder: 'male-qn-qingse / female-shaonv / presenter_male …' },
        { id: 'emotion', label: '情感', type: 'select', default: 'neutral', choices: ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'] },
        { id: 'speed', label: '语速（0.5~2）', type: 'text', default: '1.0', placeholder: '1.0' },
        { id: 'format', label: '格式', type: 'select', default: 'mp3', choices: ['mp3', 'wav', 'flac', 'pcm'] },
        { id: 'sampleRate', label: '采样率', type: 'select', default: '32000', choices: ['16000', '24000', '32000', '44100', '48000'] },
      ],
      refs: {},
      refNote: '声音克隆需先实名认证并走独立上传流程，本期未接入；使用系统音色 ID。',
      generate: generateTts,
    },
  },
}
