/** Opt-in, bounded diagnostics. Never serializes prompts, outputs, credentials or arbitrary errors. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from 'openai/resources/responses/responses'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

export interface DiagnosticOptions {
  enabled: boolean
  directory: string
  expiresAt: string
  maxRequests: number
  maxFileBytes: number
}
export interface DiagnosticSink {
  begin(body: ResponseCreateParamsStreaming, scope: string, session?: string): DiagnosticCapture | undefined
}
export type DiagnosticOutcome = 'stream-finished' | 'transport-error' | 'api-error' | 'provider-error' | 'invalid-data' | 'cancelled' | 'consumer-closed'
type JsonObject = Record<string, unknown>
type Shape = { readonly [key: string]: true | Shape }
const usageShape: Shape = {
  input_tokens: true, output_tokens: true, total_tokens: true,
  input_tokens_details: {
    cached_tokens: true, cache_write_tokens: true, cached_read_tokens: true, cached_write_tokens: true,
    text_tokens: true, image_tokens: true, audio_tokens: true,
    cache_write_tokens_details: { ttl_12h_tokens: true, ttl_30m_tokens: true },
  },
  output_tokens_details: { reasoning_tokens: true, text_tokens: true, image_tokens: true, audio_tokens: true },
}
const object = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)
async function bounded(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation.then(() => true, () => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Preserve missing/null/explicit zero; copy only known numeric usage fields, before DSH normalization. */
export function sanitizeUsage(value: unknown, present: boolean): JsonObject {
  if (!present) return { state: 'missing' }
  if (value === null) return { state: 'null' }
  if (!object(value)) return { state: 'invalid' }
  let omittedFields = 0, redactedFields = 0
  const visit = (source: JsonObject, shape: Shape): JsonObject => {
    const result: JsonObject = {}
    omittedFields += Object.keys(source).filter(key => !Object.hasOwn(shape, key)).length
    for (const [key, spec] of Object.entries(shape)) {
      if (!Object.hasOwn(source, key)) continue
      const item = source[key]
      if (item === null) result[key] = null
      else if (spec === true && typeof item === 'number' && Number.isFinite(item)) result[key] = item
      else if (spec !== true && object(item)) result[key] = visit(item, spec)
      else { result[key] = '<redacted>'; redactedFields++ }
    }
    return result
  }
  const result = visit(value, usageShape)
  return { state: 'object', value: result, omittedFields, redactedFields }
}

/** One ephemeral HMAC key per recording run prevents dictionary attacks on low-entropy prompts. */
export class Diagnostics implements DiagnosticSink {
  readonly runId = randomUUID()
  private readonly key = randomBytes(32)
  private readonly deadline: number
  private file: FileHandle | undefined
  private tail: Promise<void> = Promise.resolve()
  private count = 0
  private bytes = 0
  private stopped = false
  private closing = false
  private warned = false
  private opening: Promise<void> | undefined
  private closingTask: Promise<void> | undefined
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private readonly pending = new Set<DiagnosticCapture>()

  constructor(private readonly options: DiagnosticOptions, private readonly warn: () => void = () => {}) {
    this.deadline = Date.parse(options.expiresAt)
    if (options.enabled && (!isAbsolute(options.directory) || !Number.isFinite(this.deadline) || this.deadline > Date.now() + 86400000)) throw new Error('Diagnostics requires an absolute directory and an explicit expiry within 24 hours.')
    if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 200
      || !Number.isInteger(options.maxFileBytes) || options.maxFileBytes < 4096 || options.maxFileBytes > 10485760) throw new Error('Invalid diagnostic recording limits.')
  }

  /** Create a new private file exclusively. Never truncates or rotates an existing file. */
  async open(): Promise<void> {
    if (!this.options.enabled || Date.now() >= this.deadline || this.closing) return
    this.opening ??= this.initialize()
    if (!await bounded(this.opening, 2000)) {
      this.fail(); void this.close()
      throw new Error('SIWC diagnostic initialization failed or timed out.')
    }
    if (!this.closing && this.expiryTimer === undefined) {
      this.expiryTimer = setTimeout(() => { void this.close() }, Math.max(0, this.deadline - Date.now()))
      this.expiryTimer.unref()
    }
  }
  private async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    this.file = await open(join(this.options.directory, `siwc-${this.runId}.jsonl`), 'wx', 0o600)
    await this.enqueue({ kind: 'diagnostics-start', schemaVersion: 1, runId: this.runId,
      timestamp: new Date().toISOString(), expiresAt: new Date(this.deadline).toISOString(),
      maxRequests: this.options.maxRequests, maxFileBytes: this.options.maxFileBytes,
      digestScheme: 'HMAC-SHA256; private ephemeral key; comparable only within this run',
      usagePolicy: 'known numeric fields only; no defaults; unknown fields omitted; strings redacted',
    })
  }

  digest(value: unknown): string { return createHmac('sha256', this.key).update(JSON.stringify(value) ?? 'undefined').digest('hex') }
  private textDigest(value: string | Buffer): string { return createHmac('sha256', this.key).update(value).digest('hex') }

  private identifier(value: unknown, prefix: 'req' | 'resp'): JsonObject {
    if (value === undefined || value === null) return { present: false }
    if (typeof value === 'string' && (new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,120}$`).test(value) || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
      && !/sk-|eyJ|bearer/i.test(value)) return { present: true, value }
    return { present: true, digest: this.digest(value) }
  }

  begin(body: ResponseCreateParamsStreaming, scope: string, session?: string): DiagnosticCapture | undefined {
    if (!this.options.enabled || !this.file || this.stopped || this.closing || Date.now() >= this.deadline || this.count >= this.options.maxRequests) return
    try {
      const input = Array.isArray(body.input) ? body.input : []
      const wire = Buffer.from(JSON.stringify(body)), serializedInput = Buffer.from(JSON.stringify(body.input))
      const tools = body.tools ?? []
      const prefixSizes = [...new Set([1024, 4096, 16384, 65536].map(size => Math.min(size, serializedInput.length)))]
      const knownTypes = new Set(['message', 'reasoning', 'function_call', 'function_call_output', 'item_reference'])
      const knownRoles = new Set(['developer', 'system', 'user', 'assistant'])
      const summary: JsonObject = {
        endpoint: 'https://api.openai.com/v1/responses', requestedModel: { digest: this.digest(body.model) },
        bodyBytes: wire.length, bodyDigest: this.textDigest(wire),
        scopeDigest: this.digest(scope), sessionPresent: session !== undefined,
        ...session === undefined ? {} : { sessionDigest: this.digest(session) },
        stream: body.stream === true, store: body.store === false ? false : body.store === true ? true : null,
        cacheKey: { present: Object.hasOwn(body, 'prompt_cache_key'), ...body.prompt_cache_key === undefined ? {} : { digest: this.digest(body.prompt_cache_key) } },
        retention: { present: Object.hasOwn(body, 'prompt_cache_retention'), ...body.prompt_cache_retention === undefined ? {} : { digest: this.digest(body.prompt_cache_retention) } },
        breakpointPresent: Object.hasOwn(body, 'prompt_cache_breakpoint'),
        reasoning: { present: body.reasoning !== undefined, digest: this.digest(body.reasoning) },
        tools: { count: tools.length, digest: this.digest(tools) },
        input: { count: input.length, bytes: serializedInput.length, digest: this.textDigest(serializedInput),
          prefixes: prefixSizes.map(bytes => ({ bytes, digest: this.textDigest(serializedInput.subarray(0, bytes)) })),
          developerDigest: this.digest(input.filter(item => object(item) && (item.role === 'developer' || item.role === 'system'))),
          items: input.slice(0, 64).map((item, index) => ({ index, bytes: Buffer.byteLength(JSON.stringify(item)), digest: this.digest(item),
            type: object(item) && typeof item.type === 'string' && knownTypes.has(item.type) ? item.type : object(item) && 'role' in item ? 'message' : 'other',
            role: object(item) && typeof item.role === 'string' && knownRoles.has(item.role) ? item.role : 'other',
          })), itemSummariesTruncated: input.length > 64,
        },
      }
      const capture = new DiagnosticCapture(this, ++this.count, summary)
      this.pending.add(capture)
      return capture
    } catch { this.fail(); return }
  }

  id(value: unknown, kind: 'req' | 'resp'): JsonObject { return this.identifier(value, kind) }

  /** A write failure or byte limit disables recording, never inference. */
  private enqueue(record: JsonObject): Promise<void> {
    this.tail = this.tail.then(async () => {
      if (!this.file || this.stopped || Date.now() >= this.deadline) return
      const line = JSON.stringify(record) + '\n', bytes = Buffer.byteLength(line)
      if (this.bytes + bytes > this.options.maxFileBytes) { this.fail(); return }
      await this.file.writeFile(line)
      this.bytes += bytes
    }).catch(() => { this.fail() })
    return this.tail
  }
  private fail(): void {
    this.stopped = true
    if (!this.warned) { this.warned = true; try { this.warn() } catch { /* Diagnostic reporting must never change inference. */ } }
  }

  async save(capture: DiagnosticCapture, record: JsonObject): Promise<void> {
    this.pending.delete(capture)
    if (this.closing || this.stopped || Date.now() >= this.deadline) return
    await this.enqueue({ kind: 'request', schemaVersion: 1, runId: this.runId, ...record })
  }

  async flush(timeoutMs = 2000): Promise<boolean> {
    const drained = await bounded(this.tail, timeoutMs)
    if (!drained) this.fail()
    return drained
  }
  close(timeoutMs = 2000): Promise<void> {
    if (this.closingTask) return this.closingTask
    this.closing = true
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    this.pending.clear()
    // If an OS write cannot be cancelled, arrange eventual cleanup without blocking plugin unload.
    const drain = (async () => {
      await this.opening?.catch(() => {})
      await this.tail
      const file = this.file; this.file = undefined
      await file?.close().catch(() => {})
    })()
    this.closingTask = (async () => {
      if (!await bounded(drain, timeoutMs)) this.fail()
      this.key.fill(0)
    })()
    return this.closingTask
  }
}

/** Holds sanitized summaries only, not the original request, stream, response, or auth object. */
export class DiagnosticCapture {
  private readonly start = Date.now()
  private readonly record: JsonObject
  private terminalCount = 0
  private finished = false
  constructor(private readonly owner: Diagnostics, sequence: number, request: JsonObject) {
    this.record = { sequence, timestamp: new Date(this.start).toISOString(), request, requestSent: false, terminal: 'missing', usage: { state: 'missing' } }
  }
  sent(): void { this.record.requestSent = true }
  http(status: number | undefined, requestId: unknown): void {
    if (typeof status === 'number' && Number.isFinite(status)) this.record.httpStatus = status
    else this.record.httpStatus ??= null
    if (requestId != null || this.record.requestId === undefined) this.record.requestId = this.owner.id(requestId, 'req')
  }
  observe(event: ResponseStreamEvent): void {
    if (this.finished) return
    if (event.type !== 'response.created' && event.type !== 'response.completed' && event.type !== 'response.failed' && event.type !== 'response.incomplete') return
    const response = event.response
    if (!object(response)) { this.record.invalidResponseEnvelope = true; return }
    if (event.type === 'response.created' && this.terminalCount > 0) return
    if (event.type !== 'response.created') {
      this.terminalCount++
      if (this.terminalCount > 1) return // Keep IDs/model/usage bound to the first authoritative terminal.
      this.record.terminal = event.type
      this.record.usage = sanitizeUsage(response.usage, Object.hasOwn(response, 'usage'))
    }
    this.record.responseId = this.owner.id(response.id, 'resp')
    this.record.responseModel = { present: Object.hasOwn(response, 'model'), ...response.model === undefined ? {} : { digest: this.owner.digest(response.model) } }
  }
  translated(chunk: StreamChunk): void {
    if (chunk.type !== 'usage' || this.record.normalizedUsage !== undefined) return
    const usage = chunk.usage, result: JsonObject = {}
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
      if (Object.hasOwn(usage, key)) result[key] = typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] : '<redacted>'
    }
    this.record.normalizedUsage = result
  }
  async finish(outcome: DiagnosticOutcome): Promise<void> {
    if (this.finished) return
    this.finished = true
    await this.owner.save(this, { ...this.record, durationMs: Date.now() - this.start, terminalCount: this.terminalCount, outcome })
  }
}
