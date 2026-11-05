import { afterEach, expect, it } from 'vitest'
import { BlockAssembler, createMessage, createUserMessage, ToolCallId, ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { PlanAdapter } from '../src/adapter.ts'
import { requestBody } from '../src/messages.ts'
import { collect, deferred, fixture, imageRef, imageURL, imageVersion, message, options, textEvents, wireFetch } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())) })
async function setup() { const f = await fixture(); cleanups.push(f.cleanup); await f.login(); return f }

const attachments = { readImageRequest: async () => imageVersion }

it('keeps a session cache key stable across turns and JSON restore, with distinct sessions separated', async () => {
  const request: GenerateOptions = { provider: 'chatgpt-provider', model: 'test-model', messages: [], sessionId: 'session-a' as NonNullable<GenerateOptions['sessionId']> }
  const first = await requestBody(request, 'scope')
  const continued = await requestBody({ ...request, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'next turn' }] })] }, 'scope')
  const restored = await requestBody(JSON.parse(JSON.stringify(request)), 'scope')
  const other = await requestBody({ ...request, sessionId: 'session-b' as NonNullable<GenerateOptions['sessionId']> }, 'scope')
  expect(first.prompt_cache_key).toEqual(expect.any(String))
  expect(first.prompt_cache_key!.length).toBeGreaterThan(0)
  expect(first.prompt_cache_key!.length).toBeLessThanOrEqual(64)
  expect(continued.prompt_cache_key).toBe(first.prompt_cache_key)
  expect(restored.prompt_cache_key).toBe(first.prompt_cache_key)
  expect(other.prompt_cache_key).not.toBe(first.prompt_cache_key)
})

it('omits a session cache key when the host does not provide a session identity', async () => {
  const body = await requestBody({ provider: 'chatgpt-provider', model: 'test-model', messages: [] }, 'scope')
  expect(body).not.toHaveProperty('prompt_cache_key')
})

it('sends a stable HTTP session-id for each distinct host session', async () => {
  const f = await setup()
  const requests: { body: unknown; authorization: string | null }[] = []
  const sessionHeaders: (string | null)[] = []
  const respond = wireFetch(textEvents, requests)
  const adapter = new PlanAdapter(f.auth, options, (url, init) => {
    if (String(url).endsWith('/responses')) sessionHeaders.push(new Headers(init?.headers).get('session-id'))
    return respond(url, init)
  })
  try {
    for (const id of ['parent-session', 'parent-session', 'child-session', undefined]) {
      await collect(adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', messages: [],
        ...(id === undefined ? {} : { sessionId: id as NonNullable<GenerateOptions['sessionId']> }) }))
    }
    const [parentKey, repeatedKey, childKey, noKey] = requests.map(({ body }) => (body as { prompt_cache_key?: string }).prompt_cache_key)
    expect(parentKey).toEqual(expect.any(String))
    expect(repeatedKey).toBe(parentKey)
    expect(childKey).toEqual(expect.any(String))
    expect(childKey).not.toBe(parentKey)
    expect(noKey).toBeUndefined()
    expect(sessionHeaders).toEqual([parentKey, parentKey, childKey, null])
  } finally { await adapter.work.close() }
})

function visionFetch(requests: { body: unknown; authorization: string | null }[]): typeof fetch {
  const normal = wireFetch(textEvents, requests)
  return async (url, init) => String(url).endsWith('/models')
    ? Response.json({ models: [{ slug: 'test-model', input_modalities: ['text', 'image'] }, { slug: 'text-model', input_modalities: ['text'] }] })
    : normal(url, init)
}

it('offers image input only for catalog models that accept images', async () => {
  const f = await setup(), adapter = new PlanAdapter(f.auth, options, visionFetch([]))
  expect(await adapter.listModels('chatgpt-provider')).toMatchObject([{ id: 'test-model', inputModalities: ['text', 'image'] }, { id: 'text-model', inputModalities: ['text'] }])
  expect((await adapter.resolveModel('chatgpt-provider', 'test-model')).inputModalities).toEqual(['text', 'image'])
  expect((await adapter.resolveModel('chatgpt-provider', 'text-model')).inputModalities).toEqual(['text'])
  await adapter.work.close()
})

it('sends an attached image between text parts and preserves it after JSON history restore', async () => {
  const f = await setup(), requests: { body: unknown; authorization: string | null }[] = []
  const adapter = new PlanAdapter(f.auth, options, visionFetch(requests), () => attachments)
  const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'before' }, { type: 'image', attachment: imageRef }, { type: 'text', text: 'after' }] })
  const request = { provider: 'chatgpt-provider', model: 'test-model', messages: [user] }
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream(request)) assembler.push(chunk)
  expect(assembler.finish).toEqual({ kind: 'stop' })
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'before' }, { type: 'input_image', image_url: imageURL, detail: 'auto' }, { type: 'input_text', text: 'after' }] }]
  expect(requests[0]?.body).toMatchObject({ input, stream: true, store: false })
  const restored = JSON.parse(JSON.stringify([user, assembler.message({ provider: request.provider, model: request.model, replayState: assembler.replayState })]))
  await collect(adapter.stream({ ...request, messages: [...restored, createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'What color was the image?' }] })] }))
  expect(requests[1]?.body).toMatchObject({ input: [...input, expect.anything(), expect.anything()] })
  await adapter.work.close()
})

it('passes image tool results to the model instead of dropping the image', async () => {
  const f = await setup(), requests: { body: unknown; authorization: string | null }[] = []
  const adapter = new PlanAdapter(f.auth, options, visionFetch(requests), () => attachments)
  const callId = ToolCallId('image-call')
  const messages = [createMessage({ role: 'assistant', source: { kind: 'model', provider: 'chatgpt-provider', model: 'test-model' }, content: [{ type: 'tool-call', id: callId, name: 'view_image', arguments: '{}' }] }), createMessage({ role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: 'Screenshot' }, { type: 'image', attachment: imageRef }] })]
  await collect(adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', messages }))
  expect(requests[0]?.body).toMatchObject({ input: [expect.anything(), { type: 'function_call_output', call_id: callId, output: [{ type: 'input_text', text: 'Screenshot' }, { type: 'input_image', image_url: imageURL, detail: 'auto' }] }] })
  await adapter.work.close()
})

it('honors an offloaded image without reading or transmitting its bytes', async () => {
  const f = await setup(), requests: { body: unknown; authorization: string | null }[] = []
  let reads = 0
  const adapter = new PlanAdapter(f.auth, options, visionFetch(requests), () => ({ readImageRequest: async () => { reads++; return imageVersion } }))
  await collect(adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: imageRef, offloaded: true }] })] }))
  expect(reads).toBe(0)
  expect(JSON.stringify(requests[0]?.body)).not.toContain('data:image/')
  expect(JSON.stringify(requests[0]?.body)).toContain('pixel.png')
  await adapter.work.close()
})

it('does not send inference after an attachment read fails', async () => {
  const f = await setup(), requests: { body: unknown; authorization: string | null }[] = []
  const adapter = new PlanAdapter(f.auth, options, visionFetch(requests), () => ({ readImageRequest: async () => { throw new Error('Attachment integrity check failed') } }))
  await expect(collect(adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: imageRef }] })] }))).rejects.toThrow()
  expect(requests).toHaveLength(0)
  await adapter.work.close()
})

it('cancels an in-progress attachment read before inference starts', async () => {
  const f = await setup(), entered = deferred<void>(), caller = new AbortController()
  const requests: { body: unknown; authorization: string | null }[] = []
  const adapter = new PlanAdapter(f.auth, options, visionFetch(requests), () => ({ readImageRequest: async (_ref, _target, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    entered.resolve()
  }) }))
  const observed = collect(adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', signal: caller.signal, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: imageRef }] })] })).catch(error => error)
  await entered.promise
  caller.abort()
  expect(await observed).toMatchObject({ code: 'CHATGPT_PROVIDER_CANCELLED' })
  expect(requests).toHaveLength(0)
  await adapter.work.close()
})

it('uses public API, streams text, and preserves disjoint cache accounting', async () => {
  const f = await setup(), requests: { body: unknown; authorization: string | null }[] = []
  const adapter = new PlanAdapter(f.auth, options, wireFetch(textEvents, requests))
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })] })) assembler.push(chunk)
  expect(assembler.blocks()).toEqual([{ type: 'text', text: 'hello' }])
  expect(assembler.finish).toEqual({ kind: 'stop' })
  expect(assembler.usage).toMatchObject({ inputTokens: 6, cacheReadTokens: 4, outputTokens: 2 })
  expect(requests[0]).toMatchObject({ authorization: 'Bearer access-0', body: { model: 'test-model', stream: true, store: false } })
  await adapter.work.close()
})

it('round-trips encrypted reasoning and namespaced calls through actual DSH JSON restore', async () => {
  const f = await setup(), requests: { body: unknown; authorization: string | null }[] = []
  const native = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'echo', namespace: 'dsh', arguments: '{"text":"hi"}' },
  ]
  const adapter = new PlanAdapter(f.auth, options, wireFetch([{ type: 'response.completed', response: { output: native } }], requests))
  const assembler = new BlockAssembler()
  const request = { provider: 'chatgpt-provider', model: 'test-model', messages: [createUserMessage({ content: [{ type: 'text', text: 'echo' }], source: { kind: 'user' } })], tools: [{ name: 'echo', description: 'Echo text', parameters: { type: 'object' } }] }
  for await (const chunk of adapter.stream(request)) assembler.push(chunk)
  expect(assembler.finish).toEqual({ kind: 'tool-calls' })
  const assistant = JSON.parse(JSON.stringify(assembler.message({ provider: 'chatgpt-provider', model: 'test-model', replayState: assembler.replayState })))
  await collect(adapter.stream({ ...request, messages: [...request.messages, assistant, createMessage({ role: 'tool', content: [{ type: 'text', text: 'hi' }], source: { kind: 'tool', callId: ToolCallId('call_1') }, toolCallId: ToolCallId('call_1') })] }))
  expect(requests[1]?.body).toMatchObject({ input: [expect.anything(), ...native, { type: 'function_call_output', call_id: 'call_1', output: 'hi' }], tools: [{ type: 'namespace', name: 'dsh' }] })
  await adapter.work.close()
})

it('does not replay encrypted state after visible message edits or a model change', async () => {
  const assistant = createMessage({ role: 'assistant', content: [{ type: 'text', text: 'edited' }], source: { kind: 'model', provider: 'chatgpt-provider', model: 'test-model', replayState: { response: { kind: 'chatgpt-provider', version: 1, scope: 'scope', model: 'test-model', count: 1 }, blocks: [{ hash: 'stale', item: message }] } } })
  expect((await requestBody({ provider: 'chatgpt-provider', model: 'test-model', messages: [assistant] }, 'scope')).input).toEqual([{ type: 'message', id: assistant.id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'edited', annotations: [] }] }])
})

it('serializes the SDK-supported max reasoning effort without rewriting it', async () => {
  expect((await requestBody({ provider: 'chatgpt-provider', model: 'test-model', messages: [], reasoningEffort: ReasoningEffortId('max') }, 'scope')).reasoning).toEqual({ effort: 'max' })
})

it('keeps catalog models when a server adds an effort outside the installed SDK', async () => {
  const f = await setup()
  const adapter = new PlanAdapter(f.auth, options, async () => Response.json({ models: [{
    slug: 'test-model', display_name: 'Test model', visibility: 'list', context_window: 128000,
    supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }, { effort: 'ultra' }, { effort: 'future-effort' }],
  }] }))
  expect(await adapter.listModels('chatgpt-provider')).toMatchObject([{ id: 'test-model' }])
  expect((await adapter.resolveModel('chatgpt-provider', 'test-model')).reasoning?.efforts.map(e => e.id)).toEqual(['high', 'max'])
  await expect(collect(adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', messages: [], reasoningEffort: ReasoningEffortId('ultra') }))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  await adapter.work.close()
})

it('reports a midstream plan limit without success or replay data', async () => {
  const f = await setup()
  const adapter = new PlanAdapter(f.auth, options, wireFetch([...textEvents.slice(0, 2), { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }], []))
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', messages: [] })) assembler.push(chunk)
  expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'CHATGPT_PROVIDER_LIMIT' } })
  expect(assembler.replayState).toBeUndefined()
  await adapter.work.close()
})

it('rejects a truncated stream and unsupported controls', async () => {
  const f = await setup()
  const adapter = new PlanAdapter(f.auth, options, wireFetch(textEvents.slice(0, 2), []))
  await expect(collect(adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', messages: [] }))).rejects.toThrow('terminal')
  await expect(requestBody({ provider: 'chatgpt-provider', model: 'test-model', messages: [], maxTokens: 10 }, 'scope')).rejects.toThrow('do not support')
  await adapter.work.close()
})

it('aborts network traffic and awaits its settlement on plugin disposal', async () => {
  const f = await setup(), entered = deferred<void>()
  let settled = false
  const adapter = new PlanAdapter(f.auth, options, async (url, init) => {
    if (String(url).endsWith('/models')) return wireFetch([], [])(url, init)
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => { settled = true; reject(init.signal!.reason) }, { once: true })
      entered.resolve()
    })
  })
  const result = collect(adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', messages: [] }))
  const observed = result.catch(error => error)
  await entered.promise
  await adapter.work.close()
  expect(settled).toBe(true)
  expect(await observed).toMatchObject({ code: 'CHATGPT_PROVIDER_CANCELLED' })
})

it('rejects a response that contradicts already completed visible output', async () => {
  const f = await setup()
  const adapter = new PlanAdapter(f.auth, options, wireFetch([...textEvents.slice(0, 4), { type: 'response.completed', response: { output: [{ ...message, content: [{ type: 'output_text', text: 'different', annotations: [] }] }] } }], []))
  await expect(collect(adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', messages: [] }))).rejects.toThrow('conflicting')
  await adapter.work.close()
})

it.each(['models', 'responses'])('retires the current API-rejected token on %s without falling back to ambient API keys', async endpoint => {
  const f = await setup()
  const normal = wireFetch(textEvents, [])
  const adapter = new PlanAdapter(f.auth, options, async (url, init) => String(url).endsWith(`/${endpoint}`) ? new Response('{}', { status: 401 }) : normal(url, init))
  const result = endpoint === 'models' ? adapter.listModels('chatgpt-provider') : collect(adapter.stream({ provider: 'chatgpt-provider', model: 'test-model', messages: [] }))
  await expect(result).rejects.toMatchObject({ code: 'CHATGPT_PROVIDER_SIGN_IN_REQUIRED' })
  expect(await f.auth.connection()).toBeUndefined()
  await adapter.work.close()
})

it.each(['models', 'responses'])('keeps the refreshed login usable after an older %s request returns 401', async endpoint => {
  const f = await setup(), entered = deferred<void>(), release = deferred<void>()
  const normal = wireFetch(textEvents, [])
  const adapter = new PlanAdapter(f.auth, options, async (url, init) => {
    if (String(url).endsWith(`/${endpoint}`) && new Headers(init?.headers).get('authorization') === 'Bearer access-0') {
      entered.resolve()
      await release.promise
      return Response.json({ error: { code: 'invalid_token' } }, { status: 401 })
    }
    return normal(url, init)
  })
  const request = { provider: 'chatgpt-provider', model: 'test-model', messages: [] }
  const observed = (endpoint === 'models' ? adapter.listModels(request.provider) : collect(adapter.stream(request))).catch(error => error)
  try {
    await entered.promise
    const connection = (await f.auth.connection())!
    f.advance(3500000)
    await f.auth.usable(connection.epoch, new AbortController().signal)
    release.resolve()
    expect(await observed).toMatchObject({ code: 'CHATGPT_PROVIDER_SIGN_IN_REQUIRED' })
    expect(await f.auth.connection()).toBeDefined()
    const assembler = new BlockAssembler()
    for await (const chunk of adapter.stream(request)) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'hello' }])
    expect(assembler.finish).toEqual({ kind: 'stop' })
  } finally {
    release.resolve()
    await observed
    await adapter.work.close()
  }
})
