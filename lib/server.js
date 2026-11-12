/**
 * 创作展示台 HTTP 层：/studio 页面、/studio/api/* 接口、/studio/asset 资产服务。
 *
 * 全部路由挂在 webServer 的 /studio 前缀下，鉴权方式与内置资产路由一致
 * （通过 connection.requestRejection 校验同源会话）。
 */

import { readFile, mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonBody, sendJson, sendError, parseDataUri, extFromMime, extFromUrl, stampName } from './util.js'
import { StudioStore } from './store.js'
import { PROVIDERS, getProvider, CAPABILITIES, CAPABILITY_LABELS } from './registry.js'

/** 插件根目录（本文件位于 lib/ 下）。 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 默认输出目录：插件所在工作区下的 creative-studio-output。 */
function defaultOutputDir() {
  return resolvePath(PLUGIN_ROOT, '..', 'creative-studio-output')
}

/**
 * 注册全部 /studio 路由。
 * @param {object} ctx - cordis 上下文
 */
export function registerStudio(ctx) {
  const store = new StudioStore(ctx, process.env.CREATIVE_STUDIO_OUTPUT || defaultOutputDir())
  let pageCache = undefined

  ctx.inject(['webServer'], (scope) => {
    const unregister = scope.webServer.register({
      kind: 'prefix',
      path: '/studio',
      handler: (req, res) => handle(ctx, store, () => pageCache, (v) => { pageCache = v }, req, res),
    })
    ctx.effect(() => unregister, 'creative-studio: /studio routes')
  })

  // 预热页面缓存：插件激活时即读入工作台 HTML，首次打开不再付磁盘读取延迟
  readFile(join(PLUGIN_ROOT, 'web', 'index.html'), 'utf8')
    .then((html) => { pageCache = html })
    .catch(() => {})

  return () => {}
}

/** 组装供应商能力清单（config 接口的主体）。 */
async function buildCatalog(store) {
  const config = await store.readConfig()
  const providers = []
  for (const provider of PROVIDERS) {
    const overrides = config.providers?.[provider.id] ?? {}
    const keyRefs = [provider.keyRef, ...(provider.extraKeyRefs ?? []).map((k) => k.ref)]
    const keys = []
    for (const kr of keyRefs) {
      const label = kr === provider.keyRef ? 'API Key' : ((provider.extraKeyRefs ?? []).find((k) => k.ref === kr)?.label ?? kr)
      keys.push({ ref: kr, label, configured: (await store.readKey(kr)) !== undefined })
    }
    const capabilities = {}
    for (const cap of CAPABILITIES) {
      const spec = provider.capabilities[cap]
      if (spec === undefined) continue
      capabilities[cap] = {
        models: spec.models,
        options: spec.options ?? [],
        refs: spec.refs ?? {},
        refNote: spec.refNote ?? '',
        keyRefs: [spec.keyRef ?? provider.keyRef],
      }
    }
    providers.push({
      id: provider.id,
      name: provider.name,
      keyRef: provider.keyRef,
      baseUrl: overrides.baseUrl ?? provider.defaultBaseUrl,
      baseUrlEditable: provider.baseUrlEditable ?? false,
      enabled: overrides.enabled !== false,
      keyConfigured: keys[0]?.configured ?? false,
      keys,
      capabilities,
    })
  }
  return { providers, outputDir: store.outputDir }
}

/** 校验并规整参考素材。 */
function normalizeReferences(raw, spec) {
  const refs = Array.isArray(raw) ? raw : []
  const limits = spec.refs ?? {}
  const normalized = []
  const problems = []
  const counts = { image: 0, video: 0, audio: 0 }
  for (const item of refs) {
    const kind = item?.kind
    if (!(kind in counts)) { problems.push(`未知参考素材类型：${String(kind)}`); continue }
    const limit = limits[kind] ?? 0
    if (limit === 0) { problems.push(`该供应商/能力不支持参考${{ image: '图', video: '视频', audio: '音频' }[kind]}，已忽略：${item?.name ?? kind}`); continue }
    if (counts[kind] >= limit) { problems.push(`参考${{ image: '图', video: '视频', audio: '音频' }[kind]}最多 ${limit} 个，已忽略多余的：${item?.name ?? kind}`); continue }
    const parsed = parseDataUri(item.dataUri)
    if (parsed === undefined) { problems.push(`参考素材格式错误：${item?.name ?? kind}`); continue }
    counts[kind] += 1
    normalized.push({ kind, name: String(item.name ?? kind), mime: parsed.mime, bytes: parsed.bytes, dataUri: item.dataUri })
  }
  return { refs: normalized, problems }
}

/** 生成请求体校验。 */
function validateGenerate(body) {
  const errors = []
  if (body === null || typeof body !== 'object') errors.push('请求体必须是 JSON 对象')
  else {
    if (typeof body.provider !== 'string' || body.provider.length === 0) errors.push('缺少 provider')
    if (!CAPABILITIES.includes(body.capability)) errors.push(`capability 必须是 ${CAPABILITIES.join('/')}`)
    if (typeof body.model !== 'string' || body.model.length === 0) errors.push('缺少 model')
    if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) errors.push('缺少提示词/文本内容')
  }
  return errors
}

/** 下载适配器给出的远程 URL。 */
async function downloadArtifact(url, mime, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`下载结果失败：HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const type = response.headers.get('content-type')?.split(';')[0] ?? mime
  return { bytes, mime: type }
}

/** 运行一个生成任务（后台执行）。 */
async function runJob(store, job, body) {
  const provider = getProvider(body.provider)
  const spec = provider.capabilities[body.capability]
  try {
    const config = await store.readConfig()
    const overrides = config.providers?.[provider.id] ?? {}
    const keyRef = spec.keyRef ?? provider.keyRef
    const key = await store.readKey(keyRef)
    if (key === undefined) throw new Error(`供应商 ${provider.name} 所需的凭据 ${keyRef} 未配置，请先在工作台“设置”中填写。`)
    const result = await spec.generate({
      model: body.model,
      prompt: body.prompt.trim(),
      negativePrompt: typeof body.negativePrompt === 'string' ? body.negativePrompt.trim() : '',
      refs: job.refs,
      options: body.options ?? {},
      key,
      baseUrl: overrides.baseUrl ?? provider.defaultBaseUrl,
      signal: job.signal,
    })
    let { bytes, mime } = result
    if ((bytes === undefined || bytes === null) && typeof result.url === 'string') {
      const downloaded = await downloadArtifact(result.url, result.mime, job.signal)
      bytes = downloaded.bytes
      mime = mime ?? downloaded.mime
    }
    if (bytes === undefined || bytes === null) throw new Error('供应商没有返回可保存的结果')
    const ext = result.ext ?? extFromUrl(result.url ?? '', mime ?? result.mime, extFromMime(mime ?? result.mime, 'bin'))
    const name = stampName(body.capability, provider.id, ext)
    await mkdir(store.outputDir, { recursive: true })
    const filePath = join(store.outputDir, name)
    await writeFile(filePath, bytes)
    const entry = {
      id: job.id,
      name,
      kind: body.capability,
      provider: provider.id,
      providerName: provider.name,
      model: body.model,
      prompt: body.prompt.trim(),
      options: body.options ?? {},
      references: job.refs.map((r) => ({ kind: r.kind, name: r.name, mime: r.mime })),
      warnings: job.problems,
      mime: mime ?? 'application/octet-stream',
      bytes: bytes.length,
      path: filePath,
      remoteUrl: typeof result.url === 'string' ? result.url : null,
      meta: result.meta ?? null,
      createdAt: new Date().toISOString(),
    }
    await store.recordGallery(entry)
    store.updateJob(job.id, { status: 'succeeded', artifact: { name, path: filePath, mime: entry.mime, bytes: entry.bytes } })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    store.updateJob(job.id, { status: 'failed', error: reason })
  }
}

/** /studio 路由分发。 */
async function handle(ctx, store, getPage, setPage, req, res) {
  // 鉴权：与内置资产路由一致；connection 服务缺失时放行（本机使用）。
  const connection = ctx.get('connection')
  const rejection = connection?.requestRejection?.(req)
  if (typeof rejection === 'number') {
    res.statusCode = rejection
    res.end()
    return
  }

  const url = new URL(String(req.url ?? '/'), 'http://localhost')
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  try {
    // 工作台页面
    if (pathname === '/studio' || pathname === '/studio/') {
      if (method !== 'GET' && method !== 'HEAD') { sendError(res, 405, 'method not allowed'); return }
      let html = getPage()
      if (html === undefined) {
        html = await readFile(join(PLUGIN_ROOT, 'web', 'index.html'), 'utf8')
        setPage(html)
      }
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(html)
      return
    }

    // 资产服务
    if (pathname === '/studio/asset') {
      const target = url.searchParams.get('path') ?? ''
      const resolved = resolvePath(target)
      if (resolved !== store.outputDir && !resolved.startsWith(store.outputDir + '\\') && !resolved.startsWith(store.outputDir + '/')) {
        sendError(res, 403, 'path outside output dir')
        return
      }
      let info
      try { info = await stat(resolved) } catch { sendError(res, 404, 'not found'); return }
      if (!info.isFile()) { sendError(res, 404, 'not found'); return }
      res.statusCode = 200
      res.setHeader('accept-ranges', 'bytes')
      res.setHeader('cache-control', 'private, max-age=3600')
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
      const body = await readFile(resolved)
      const type = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac' })[resolved.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
      res.setHeader('content-type', type)
      if (range === null) {
        res.setHeader('content-length', String(body.length))
        res.end(method === 'HEAD' ? undefined : body)
        return
      }
      const start = range[1] === '' ? 0 : Number(range[1])
      const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= body.length) {
        res.statusCode = 416
        res.setHeader('content-range', `bytes */${body.length}`)
        res.end()
        return
      }
      res.statusCode = 206
      res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`)
      res.setHeader('content-length', String(end - start + 1))
      res.end(method === 'HEAD' ? undefined : body.subarray(start, end + 1))
      return
    }

    // REST API
    if (pathname === '/studio/api/config' && method === 'GET') {
      sendJson(res, 200, await buildCatalog(store))
      return
    }

    if (pathname === '/studio/api/config' && method === 'POST') {
      const body = await readJsonBody(req)
      if (body === null || typeof body !== 'object' || typeof body.provider !== 'string') {
        sendError(res, 400, '缺少 provider'); return
      }
      const provider = getProvider(body.provider)
      if (provider === undefined) { sendError(res, 404, '未知供应商'); return }
      const config = await store.readConfig()
      const providers = { ...(config.providers ?? {}) }
      const entry = { ...(providers[provider.id] ?? {}) }
      const keyPatch = body.keys !== null && typeof body.keys === 'object' ? body.keys : {}
      if (typeof body.apiKey === 'string' && body.apiKey.length > 0) {
        await store.writeKey(provider.keyRef, body.apiKey.trim())
      }
      if (body.apiKey === '') { await store.clearKey(provider.keyRef) }
      for (const [ref, value] of Object.entries(keyPatch)) {
        if (typeof value !== 'string') continue
        if (value.length === 0) await store.clearKey(ref)
        else await store.writeKey(ref, value.trim())
      }
      if (typeof body.baseUrl === 'string') entry.baseUrl = body.baseUrl.trim()
      if (typeof body.enabled === 'boolean') entry.enabled = body.enabled
      providers[provider.id] = entry
      await store.patchConfig({ providers })
      sendJson(res, 200, { ok: true })
      return
    }

    if (pathname === '/studio/api/generate' && method === 'POST') {
      const body = await readJsonBody(req)
      const errors = validateGenerate(body)
      if (errors.length > 0) { sendError(res, 400, errors.join('；')); return }
      const provider = getProvider(body.provider)
      const spec = provider.capabilities[body.capability]
      if (spec === undefined) { sendError(res, 400, `${provider.name} 不支持${CAPABILITY_LABELS[body.capability]}`); return }
      if (!spec.models.some((m) => m.id === body.model)) { sendError(res, 400, `模型 ${body.model} 不在 ${provider.name} 的 ${body.capability} 模型列表中`); return }
      const { refs, problems } = normalizeReferences(body.references, spec)
      const job = store.createJob({ capability: body.capability, provider: provider.id, providerName: provider.name, model: body.model, prompt: body.prompt.trim(), refs, problems })
      runJob(store, job, body)
      sendJson(res, 200, { taskId: job.id, warnings: problems })
      return
    }

    const jobMatch = /^\/studio\/api\/job\/([a-z0-9]+)$/i.exec(pathname)
    if (jobMatch !== null && method === 'GET') {
      const job = store.getJob(jobMatch[1])
      if (job === undefined) { sendError(res, 404, '任务不存在或已过期'); return }
      const { refs, signal, ...publicJob } = job
      sendJson(res, 200, publicJob)
      return
    }

    if (pathname === '/studio/api/jobs' && method === 'GET') {
      sendJson(res, 200, { jobs: store.listJobs().map(({ refs, signal, ...rest }) => rest) })
      return
    }

    if (pathname === '/studio/api/gallery' && method === 'GET') {
      sendJson(res, 200, { entries: await store.listGallery() })
      return
    }

    if (pathname === '/studio/api/gallery' && method === 'DELETE') {
      const name = url.searchParams.get('name') ?? ''
      const deleteFile = url.searchParams.get('file') !== 'false'
      if (name.length === 0) { sendError(res, 400, '缺少 name'); return }
      const ok = await store.removeGallery(name, deleteFile)
      sendJson(res, 200, { ok })
      return
    }

    sendError(res, 404, 'not found')
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error))
  }
}
