/**
 * 云存档（用户级，要 saves.read）。
 *
 * ⚠️ **只读接口**：列表（`/v1/saves`）与取一份存档的二进制（`/v1/saves/:runtime/:slug`）。
 * 写入 / 覆盖 / 删除是 saves.write（sensitive，scope 表里标了），不在这一版 SDK 里——
 * 那一支要的审核比读严，等后端把写入接口也开出来再补。
 */
import { OpenApiError, type OpenApiErrorBody } from '../errors'
import { buildQuery } from '../client'
import type { BitgoOpenClient } from '../client'
import type { SaveData, SaveList } from '../types'

export class SavesResource {
  constructor(private readonly client: BitgoOpenClient) {}

  /** `GET /v1/saves` —— 存档清单（只给元信息，不含二进制）。 */
  list(): Promise<SaveList> {
    return this.client.requestUser<SaveList>('/v1/saves')
  }

  /**
   * `GET /v1/saves/:runtime/:slug?slot=0` —— 取一份存档的**二进制**。
   *
   * @returns 原始字节（emulatorjs 快照 / jsdos 变更包等）+ 服务端记录的更新时间。
   */
  async get(runtime: string, slug: string, opts: { slot?: number } = {}): Promise<SaveData> {
    const path = `/v1/saves/${encodeURIComponent(runtime)}/${encodeURIComponent(slug)}${buildQuery({
      slot: opts.slot,
    })}`
    const res = await this.client.requestUserRaw(path)
    if (!res.ok) {
      const text = await res.text()
      const data: unknown = text ? safeJson(text) : null
      if (isErrorBody(data)) throw new OpenApiError(res.status, data)
      throw new OpenApiError(res.status, { error: 'unknown', error_description: typeof data === 'string' ? data : `HTTP ${res.status}` })
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    return {
      runtime,
      slug,
      slot: opts.slot ?? 0,
      data: buf,
      updatedAt: Number(res.headers.get('x-save-updated-at')) || 0,
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function isErrorBody(v: unknown): v is OpenApiErrorBody {
  return typeof v === 'object' && v !== null && typeof (v as OpenApiErrorBody).error === 'string'
}
