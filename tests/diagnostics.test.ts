import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Diagnostics, sanitizeUsage, type DiagnosticOptions, type DiagnosticSink } from '../src/diagnostics.ts'
import { PlanAdapter } from '../src/adapter.ts'
import { requestBody } from '../src/messages.ts'
import * as DiagnosticPlugin from '../src/diagnostics-plugin.ts'
import { collect, fixture, message, options, textEvents, wireFetch } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const secret = 'PRIVATE_PROMPT_AND_OUTPUT_926713'
const request: GenerateOptions = {
  provider: 'chatgpt-provider', model: 'test-model', sessionId: 'private-session' as GenerateOptions['sessionId'] & string,
  system: secret, messages: [createUserMessage({ content: [{ type: 'text', text: secret }], source: { kind: 'user' } })],
  tools: [{ name: 'private-tool', description: secret, parameters: { type: 'object', properties: { private_argument: { type: 'string', description: secret } } } }],
}
async function recording(overrides: Partial<DiagnosticOptions> = {}) {
  // This exact absolute directory is created for this test and is the only deletion target.
  const directory = await mkdtemp(join(tmpdir(), 'siwc-diag-test-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const config = { enabled: true, directory: join(directory, 'recordings'), expiresAt: new Date(Date.now() + 3600000).toISOString(), maxRequests: 32, maxFileBytes: 1048576, ...overrides }
  const warn = vi.fn(), recorder = new Diagnostics(config, warn)
  cleanup.push(() => recorder.close())
  await recorder.open()
  const read = async () => {
    await recorder.flush()
    const names = await readdir(config.directory)
    expect(names).toHaveLength(1)
    const path = join(config.directory, names[0]!)
    const text = await readFile(path, 'utf8')
    return { text, path, rows: text.trim().split('\n').map(line => JSON.parse(line) as Record<string, any>) }
  }
  return { config, recorder, warn, read }
}
const event = (response: object, type = 'response.completed') => ({ type, response }) as ResponseStreamEvent

it('preserves absent/null/explicit-zero usage and redacts unknown fields and nonnumeric values', () => {
  expect(sanitizeUsage(undefined, false)).toEqual({ state: 'missing' })
  expect(sanitizeUsage(null, true)).toEqual({ state: 'null' })
  expect(sanitizeUsage(secret, true)).toEqual({ state: 'invalid' })
  expect(sanitizeUsage({ input_tokens: 0, input_tokens_details: { cached_tokens: 0 } }, true)).toEqual({
    state: 'object', value: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 } }, omittedFields: 0, redactedFields: 0,
  })
  const sanitized = sanitizeUsage({ input_tokens: 10, [secret]: secret, input_tokens_details: { cached_tokens: secret, cache_write_tokens: 3, cache_write_tokens_details: { ttl_12h_tokens: 3 } } }, true)
  expect(JSON.stringify(sanitized)).not.toContain(secret)
  expect(sanitized).toMatchObject({ omittedFields: 1, redactedFields: 1, value: { input_tokens_details: { cached_tokens: '<redacted>', cache_write_tokens: 3 } } })
  expect((sanitized.value as object)).not.toHaveProperty('output_tokens')
})

it('does not create any output directory when disabled', async () => {
  const r = await recording({ enabled: false })
  expect(r.recorder.begin(await requestBody(request, 'scope'), 'scope')).toBeUndefined()
  await expect(stat(r.config.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects enabled recording without an absolute directory or explicit valid expiry', () => {
  const config = { enabled: true, directory: 'relative', expiresAt: '', maxRequests: 32, maxFileBytes: 4096 }
  expect(() => new Diagnostics(config)).toThrow('absolute directory')
})

it('writes bounded HMAC summaries without changing the request or retaining private content', async () => {
  const r = await recording(), body = await requestBody(request, 'scope')
  const original = JSON.stringify(body)
  const a = r.recorder.begin(body, 'private-scope', request.sessionId)!
  a.sent(); a.http(200, 'req_example'); a.observe(event({ id: 'resp_example', model: 'test-model', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } }, output: [{ text: secret }] }))
  a.translated({ type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 1, totalTokens: 12 } })
  await a.finish('stream-finished'); await a.finish('transport-error')
  const { text, rows } = await r.read()
  expect(JSON.stringify(body)).toBe(original)
  for (const forbidden of [secret, 'private-scope', 'private-session', 'private-tool', 'private_argument', body.prompt_cache_key!]) expect(text).not.toContain(forbidden)
  expect(rows).toHaveLength(2)
  expect(rows[1]).toMatchObject({ kind: 'request', requestSent: true, terminal: 'response.completed', terminalCount: 1, requestId: { value: 'req_example' }, responseId: { value: 'resp_example' }, usage: { state: 'object', value: { input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 } } }, normalizedUsage: { inputTokens: 4, cacheWriteTokens: 2 } })
})

it('keeps hashes comparable within a run, changes them across runs, and detects changed tools/prefixes', async () => {
  const r = await recording(), other = await recording(), body = await requestBody(request, 'scope')
  const a = r.recorder.begin(body, 'scope')!, b = r.recorder.begin(body, 'scope')!, c = other.recorder.begin(body, 'scope')!
  await a.finish('consumer-closed'); await b.finish('consumer-closed'); await c.finish('consumer-closed')
  const rows = (await r.read()).rows, otherRows = (await other.read()).rows
  expect(rows[1]!.request.bodyDigest).toBe(rows[2]!.request.bodyDigest)
  expect(rows[1]!.request.bodyDigest).not.toBe(otherRows[1]!.request.bodyDigest)
  const changed = await requestBody({ ...request, system: secret + 'changed', tools: [{ ...request.tools![0]!, description: 'changed' }] }, 'scope')
  await r.recorder.begin(changed, 'scope')!.finish('consumer-closed')
  const last = (await r.read()).rows[3]!
  expect(last.request.tools.digest).not.toBe(rows[1]!.request.tools.digest)
  expect(last.request.input.developerDigest).not.toBe(rows[1]!.request.input.developerDigest)
})

it('does not emit arbitrary header IDs, error messages, or unexpected response metadata', async () => {
  const r = await recording(), a = r.recorder.begin(await requestBody(request, 'scope'), 'scope')!
  a.http(400, 'Bearer secret-access-token')
  a.observe(event({ id: secret, model: secret, usage: null, error: { message: secret }, output: secret }, 'response.failed'))
  await a.finish('api-error')
  const { text, rows } = await r.read()
  expect(text).not.toContain(secret); expect(text).not.toContain('secret-access-token')
  expect(rows[1]).toMatchObject({ requestId: { present: true, digest: expect.any(String) }, usage: { state: 'null' } })
})

it('enforces request admission limits across concurrent captures and ignores disposed captures', async () => {
  const r = await recording({ maxRequests: 2 }), body = await requestBody(request, 'scope')
  const captures = Array.from({ length: 10 }, () => r.recorder.begin(body, 'scope')).filter(x => x !== undefined)
  expect(captures).toHaveLength(2)
  await Promise.all(captures.map(a => a.finish('consumer-closed')))
  expect((await r.read()).rows).toHaveLength(3)
  await r.recorder.close()
  expect(r.recorder.begin(body, 'scope')).toBeUndefined()
})

it('stops at its byte limit without writing truncated JSON records', async () => {
  const r = await recording({ maxFileBytes: 4096 })
  const many = { ...request, messages: Array.from({ length: 70 }, () => request.messages[0]!) }
  const a = r.recorder.begin(await requestBody(many, 'scope'), 'scope')!
  await a.finish('consumer-closed')
  const { text, rows } = await r.read()
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096)
  expect(rows).toHaveLength(1); expect(r.warn).toHaveBeenCalledTimes(1)
  expect(r.recorder.begin(await requestBody(request, 'scope'), 'scope')).toBeUndefined()
})

it('stops admission at the absolute expiry and drains open/close races safely', async () => {
  const r = await recording()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(r.config.expiresAt) + 1)
  expect(r.recorder.begin(await requestBody(request, 'scope'), 'scope')).toBeUndefined()
  vi.restoreAllMocks()
  const second = new Diagnostics({ ...r.config, directory: join(r.config.directory, 'race') })
  await Promise.all([second.open(), second.close()])
  expect(second.begin(await requestBody(request, 'scope'), 'scope')).toBeUndefined()
})

it('swallows write failures, warns without raw errors, and disables further recording', async () => {
  const r = await recording(), a = r.recorder.begin(await requestBody(request, 'scope'), 'scope')!
  await (r.recorder as unknown as { file: FileHandle }).file.close()
  await expect(a.finish('transport-error')).resolves.toBeUndefined()
  expect(r.warn).toHaveBeenCalledTimes(1)
  expect(r.recorder.begin(await requestBody(request, 'scope'), 'scope')).toBeUndefined()
})

async function adapterWith(events: object[], fetcher?: typeof fetch) {
  const f = await fixture(); cleanup.push(f.cleanup); await f.login()
  const r = await recording()
  const requests: { body: unknown; authorization: string | null }[] = []
  const normal = wireFetch(events, requests)
  const withID: typeof fetch = async (url, init) => {
    const response = await normal(url, init)
    response.headers.set('x-request-id', 'req_offline_test')
    return response
  }
  const adapter = new PlanAdapter(f.auth, options, fetcher ?? withID, undefined, () => r.recorder)
  cleanup.push(() => adapter.work.close())
  return { ...r, adapter, requests }
}

it('records pre-normalized and normalized usage through the real adapter/SDK without extra calls', async () => {
  const r = await adapterWith([...textEvents.slice(0, -1), event({ id: 'resp_offline_test', model: 'test-model', output: [message], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 } } })])
  const chunks = await collect(r.adapter.stream(request))
  expect(r.requests).toHaveLength(1)
  expect(chunks.find(c => c.type === 'usage')).toMatchObject({ usage: { inputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 3 } })
  const { rows, text } = await r.read()
  expect(rows[1]).toMatchObject({ httpStatus: 200, requestId: { value: 'req_offline_test' }, usage: { value: { input_tokens: 10, input_tokens_details: { cache_write_tokens: 3 } } }, normalizedUsage: { inputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 3 }, outcome: 'stream-finished' })
  expect(text).not.toMatch(/access-0|refresh-0|PRIVATE_PROMPT|Bearer/)
})

it.each(['response.failed', 'response.incomplete'])('captures %s usage without preserving error/output text', async terminal => {
  const r = await adapterWith([event({ usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 7 } }, error: { message: secret }, incomplete_details: { reason: 'max_output_tokens' } }, terminal)])
  const chunks = await collect(r.adapter.stream(request)), { text, rows } = await r.read()
  expect(chunks.find(c => c.type === 'usage')).toMatchObject({ usage: { inputTokens: 3, cacheWriteTokens: 7 } })
  expect(rows[1]).toMatchObject({ terminal, usage: { state: 'object', value: { input_tokens_details: { cached_tokens: 0, cache_write_tokens: 7 } } } })
  expect(text).not.toContain(secret)
})

it('records missing terminal/usage on truncation without logging output text', async () => {
  const r = await adapterWith(textEvents.slice(0, 2))
  await expect(collect(r.adapter.stream(request))).rejects.toMatchObject({ code: 'CHATGPT_PROVIDER_INVALID_DATA' })
  expect((await r.read()).rows[1]).toMatchObject({ terminal: 'missing', usage: { state: 'missing' }, outcome: 'invalid-data' })
})

it('records invalid usage before translator validation, redacting hostile strings', async () => {
  const r = await adapterWith([event({ output: [message], usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: secret } } })])
  await expect(collect(r.adapter.stream(request))).rejects.toMatchObject({ code: 'CHATGPT_PROVIDER_INVALID_DATA' })
  const { text, rows } = await r.read()
  expect(text).not.toContain(secret)
  expect(rows[1]).toMatchObject({ outcome: 'invalid-data', usage: { redactedFields: 1, value: { input_tokens_details: { cached_tokens: '<redacted>' } } } })
})

it('ignores malformed created envelopes in optional diagnostics, like the uninstrumented adapter', async () => {
  const r = await adapterWith([{ type: 'response.created', response: null }, ...textEvents])
  const chunks = await collect(r.adapter.stream(request))
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect((await r.read()).rows[1]).toMatchObject({ invalidResponseEnvelope: true, outcome: 'stream-finished' })
})

it('isolates throwing and rejecting diagnostic hooks from model results', async () => {
  const f = await fixture(); cleanup.push(f.cleanup); await f.login()
  const broken = { begin: () => ({ sent() { throw new Error(secret) }, http() { throw new Error(secret) }, observe() { throw new Error(secret) }, translated() { throw new Error(secret) }, finish: async () => { throw new Error(secret) } }) } as unknown as DiagnosticSink
  const adapter = new PlanAdapter(f.auth, options, wireFetch(textEvents, []), undefined, () => broken)
  cleanup.push(() => adapter.work.close())
  expect((await collect(adapter.stream(request))).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
})

it('captures HTTP failures without retaining API error bodies', async () => {
  const normal = wireFetch([], [])
  const fetcher: typeof fetch = async (url, init) => String(url).endsWith('/models') ? normal(url, init) : Response.json({ error: { message: secret, code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'x-request-id': 'req_rate_limit' } })
  const r = await adapterWith([], fetcher)
  await expect(collect(r.adapter.stream(request))).rejects.toThrow()
  const { text, rows } = await r.read()
  expect(rows[1]).toMatchObject({ outcome: 'api-error', httpStatus: 429, requestId: { value: 'req_rate_limit' }, terminal: 'missing' })
  expect(text).not.toContain(secret)
})

it('does not block model completion or plugin shutdown on a stalled diagnostic write', async () => {
  const r = await adapterWith(textEvents)
  const handle = (r.recorder as unknown as { file: FileHandle }).file
  let release!: () => void
  const stalled = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(handle, 'writeFile').mockImplementationOnce(() => stalled)
  try {
    const chunks = await collect(r.adapter.stream(request))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    await expect(r.recorder.close(10)).resolves.toBeUndefined()
    expect(r.warn).toHaveBeenCalledTimes(1)
  } finally { release(); await stalled; await handle.close().catch(() => {}) }
})

it('keeps the first terminal identity/usage pair and counts duplicate terminals', async () => {
  const r = await recording(), a = r.recorder.begin(await requestBody(request, 'scope'), 'scope')!
  a.observe(event({ id: 'resp_first', model: 'first', usage: { input_tokens: 10 } }))
  a.observe(event({ id: 'resp_second', model: 'second', usage: { input_tokens: 99 } }))
  await a.finish('stream-finished')
  expect((await r.read()).rows[1]).toMatchObject({ responseId: { value: 'resp_first' }, terminalCount: 2, usage: { value: { input_tokens: 10 } } })
})

it('does not write an admitted request after its hard expiry', async () => {
  const r = await recording(), a = r.recorder.begin(await requestBody(request, 'scope'), 'scope')!
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(r.config.expiresAt) + 1)
  a.observe(event({ usage: { input_tokens: 10 } }))
  await a.finish('stream-finished')
  expect((await r.read()).rows).toHaveLength(1)
})

it('owns the optional service/file lifetime through the actual Cordis context', async () => {
  const f = await fixture(); cleanup.push(f.cleanup)
  const r = await recording(); await r.recorder.close()
  const fork = f.ctx.plugin(DiagnosticPlugin, { ...r.config, directory: join(r.config.directory, 'plugin') })
  await fork
  expect(f.ctx.get('chatgptDiagnostics')).toBeDefined()
  await fork.dispose()
  expect(f.ctx.get('chatgptDiagnostics')).toBeUndefined()
})
