/** 存储：凭据读写、插件配置、作品清单（gallery）、生成任务状态。 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { taskId } from './util.js'

/** 插件整体配置所在的凭据引用（JSON 字符串）。 */
export const CONFIG_REF = 'CREATIVE_STUDIO_CONFIG'

/** 作品清单文件名。 */
const MANIFEST_NAME = 'index.jsonl'

/** 清单最多保留条数。 */
const MANIFEST_LIMIT = 500

export class StudioStore {
  /**
   * @param {object} ctx - cordis 上下文
   * @param {string} outputDir - 作品输出目录（绝对路径）
   */
  constructor(ctx, outputDir) {
    this.ctx = ctx
    this.outputDir = outputDir
    this.jobs = new Map()
  }

  /** @returns {object|undefined} 凭据服务 */
  get credentials() { return this.ctx.get('credentials') }

  /**
   * 读凭据引用的值。
   * @param {string} ref
   * @returns {Promise<string|undefined>}
   */
  async readKey(ref) {
    const credentials = this.credentials
    if (credentials === undefined) return undefined
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved === undefined) return undefined
      const value = typeof resolved === 'string' ? resolved : resolved?.value
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch { return undefined }
  }

  /**
   * 写凭据引用。
   * @param {string} ref
   * @param {string} value
   */
  async writeKey(ref, value) {
    const credentials = this.credentials
    if (credentials === undefined) throw new Error('凭据服务不可用')
    if (typeof credentials.set !== 'function') throw new Error('当前凭据存储不支持写入')
    await credentials.set(ref, value)
  }

  /** 清除凭据引用。 */
  async clearKey(ref) {
    const credentials = this.credentials
    if (credentials === undefined || typeof credentials.unset !== 'function') return
    try { await credentials.unset(ref) } catch {}
  }

  /** 读插件配置（provider 覆盖项等）。 */
  async readConfig() {
    const raw = await this.readKey(CONFIG_REF)
    if (raw === undefined) return {}
    try {
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch { return {} }
  }

  /** 合并写插件配置。 */
  async patchConfig(patch) {
    const current = await this.readConfig()
    const next = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete next[key]
      else next[key] = value
    }
    await this.writeKey(CONFIG_REF, JSON.stringify(next))
    return next
  }

  // ---------- 作品清单 ----------

  /** 读取全部作品记录（最新在前）。 */
  async listGallery() {
    try {
      const raw = await readFile(join(this.outputDir, MANIFEST_NAME), 'utf8')
      const entries = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try { entries.push(JSON.parse(trimmed)) } catch {}
      }
      return entries
    } catch { return [] }
  }

  /** 追加一条作品记录（最新在前，限量保留）。 */
  async recordGallery(entry) {
    const existing = await this.listGallery()
    const next = [JSON.stringify(entry), ...existing.map((e) => JSON.stringify(e))].slice(0, MANIFEST_LIMIT)
    try {
      await mkdir(this.outputDir, { recursive: true })
      await writeFile(join(this.outputDir, MANIFEST_NAME), next.join('\n') + '\n')
    } catch {}
  }

  /** 删除一条作品记录（按文件名）；deleteFile 为 true 时同时删文件。 */
  async removeGallery(name, deleteFile) {
    const existing = await this.listGallery()
    const kept = existing.filter((e) => e.name !== name)
    const removed = existing.filter((e) => e.name === name)
    if (kept.length !== existing.length) {
      await writeFile(join(this.outputDir, MANIFEST_NAME), kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''))
    }
    if (deleteFile === true && removed.length > 0) {
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(this.outputDir, name)) } catch {}
    }
    return removed.length > 0
  }

  // ---------- 生成任务 ----------

  /** 创建任务记录。 */
  createJob(meta) {
    const job = { id: taskId(), status: 'running', createdAt: new Date().toISOString(), ...meta }
    this.jobs.set(job.id, job)
    // 内存中最多保留 200 条任务
    if (this.jobs.size > 200) {
      const oldest = this.jobs.keys().next().value
      if (oldest !== undefined) this.jobs.delete(oldest)
    }
    return job
  }

  /** 更新任务。 */
  updateJob(id, patch) {
    const job = this.jobs.get(id)
    if (job === undefined) return undefined
    Object.assign(job, patch)
    return job
  }

  /** 查询任务。 */
  getJob(id) { return this.jobs.get(id) }

  /** 最近任务列表。 */
  listJobs(limit = 50) {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
  }
}
