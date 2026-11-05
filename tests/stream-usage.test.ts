import { describe, expect, it } from 'vitest'
import type { ResponseStreamEvent, ResponseUsage } from 'openai/resources/responses/responses'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Translator } from '../src/stream.ts'

type Terminal = 'response.completed' | 'response.failed' | 'response.incomplete'
const terminals: Terminal[] = ['response.completed', 'response.failed', 'response.incomplete']
const message = {
  type: 'message', id: 'message-usage-test', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'answer', annotations: [] }],
}
const fullUsage: ResponseUsage = {
  input_tokens: 120, input_tokens_details: { cached_tokens: 70, cache_write_tokens: 30 },
  output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 130,
}
function terminal(type: Terminal, usage?: unknown, incompleteReason = 'max_output_tokens'): ResponseStreamEvent {
  // Deliberately minimal wire fixtures also exercise fields omitted by real responses.
  return { type, response: {
    output: [message], ...(usage === undefined ? {} : { usage }),
    error: { code: 'subscription_sharing_usage_limit_exceeded' },
    incomplete_details: { reason: incompleteReason },
  } } as unknown as ResponseStreamEvent
}
function usages(chunks: StreamChunk[]) { return chunks.filter(chunk => chunk.type === 'usage') }
function expectTerminal(chunks: StreamChunk[], type: Terminal) {
  const finish = chunks.find(chunk => chunk.type === 'finish')!
  expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
  if (type === 'response.completed') {
    expect(finish.reason).toEqual({ kind: 'stop' })
    expect(finish.replayState).toBeDefined()
  } else {
    expect(finish.reason).toMatchObject(type === 'response.failed'
      ? { kind: 'error', failure: { code: 'CHATGPT_PROVIDER_LIMIT' } }
      : { kind: 'max-tokens' })
    expect(finish).not.toHaveProperty('replayState')
  }
}

describe.each(terminals)('%s usage', type => {
  it('keeps uncached, read, and write input disjoint before the terminal finish', () => {
    const translator = new Translator('test-model', 'test-scope')
    const chunks = translator.push(terminal(type, fullUsage))
    expect(usages(chunks)).toEqual([{ type: 'usage', usage: {
      inputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 30,
      outputTokens: 10, reasoningTokens: 4, totalTokens: 130,
    } }])
    expect(usages(chunks)[0]!.usage).not.toHaveProperty('cachedWriteTokens')
    expect(chunks.at(-2)?.type).toBe('usage')
    expectTerminal(chunks, type)
    expect(() => translator.finish()).not.toThrow()
  })

  it.each([undefined, null])('does not invent usage when usage is %s', usage => {
    const translator = new Translator('test-model', 'test-scope')
    const chunks = translator.push(terminal(type, usage))
    expect(usages(chunks)).toEqual([])
    expectTerminal(chunks, type)
    expect(() => translator.finish()).not.toThrow()
  })

  it.each([
    ['missing details', undefined],
    ['null details', null],
    ['missing counters', {}],
    ['explicit zero', { cached_tokens: 0, cache_write_tokens: 0 }],
  ])('defaults %s to zero, not to missing usage', (_label, details) => {
    const { input_tokens_details: _input, output_tokens_details: _output, ...base } = fullUsage
    const chunks = new Translator('test-model', 'test-scope').push(terminal(type, {
      ...base, ...(details === undefined ? {} : { input_tokens_details: details }),
    }))
    expect(usages(chunks)).toEqual([{ type: 'usage', usage: {
      inputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: 10, reasoningTokens: 0, totalTokens: 130,
    } }])
    expectTerminal(chunks, type)
  })

  it.each([
    [{ cached_tokens: 70 }, { inputTokens: 50, cacheReadTokens: 70, cacheWriteTokens: 0 }],
    [{ cache_write_tokens: 30 }, { inputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 30 }],
  ])('defaults only the absent cache counter', (details, expected) => {
    const chunks = new Translator('test-model', 'test-scope').push(terminal(type, { ...fullUsage, input_tokens_details: details }))
    expect(usages(chunks)[0]!.usage).toMatchObject(expected)
  })

  it('keeps explicit all-zero usage', () => {
    const chunks = new Translator('test-model', 'test-scope').push(terminal(type, {
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    }))
    expect(usages(chunks)).toEqual([{ type: 'usage', usage: {
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    } }])
  })

  it('ignores progress usage and all repeated or conflicting terminal events', () => {
    const translator = new Translator('test-model', 'test-scope')
    const progress = { ...terminal(type, fullUsage), type: 'response.in_progress' } as ResponseStreamEvent
    expect(translator.push(progress)).toEqual([])
    expect(usages(translator.push(terminal(type, fullUsage)))).toHaveLength(1)
    for (const repeated of terminals) expect(translator.push(terminal(repeated, fullUsage))).toEqual([])
    expect(translator.close()).toEqual([])
    expect(() => translator.finish()).not.toThrow()
  })

  it.each([undefined, -1, Number.NaN, 999])('omits unavailable or inconsistent total %s without losing valid categories', total => {
    const chunks = new Translator('test-model', 'test-scope').push(terminal(type, { ...fullUsage, total_tokens: total }))
    expect(usages(chunks)[0]!.usage).not.toHaveProperty('totalTokens')
    expect(usages(chunks)[0]!.usage).toMatchObject({ inputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 30, outputTokens: 10 })
  })

  it.each([
    { input_tokens: -1 },
    { input_tokens: 120.5 },
    { input_tokens: Number.POSITIVE_INFINITY },
    { input_tokens_details: { cached_tokens: 100, cache_write_tokens: 21 } },
    { input_tokens_details: { cached_tokens: Number.NaN, cache_write_tokens: 0 } },
    { input_tokens_details: { cached_tokens: 0, cache_write_tokens: -1 } },
    { output_tokens_details: { reasoning_tokens: 11 } },
  ])('rejects impossible counts with the existing safe invalid-data error', override => {
    const translator = new Translator('test-model', 'test-scope')
    expect(() => translator.push(terminal(type, { ...fullUsage, ...override }))).toThrow(expect.objectContaining({
      code: 'CHATGPT_PROVIDER_INVALID_DATA', message: 'OpenAI returned invalid token usage counts.',
    }))
  })
})

describe.each(['response.failed', 'response.incomplete'] as const)('%s partial output', type => {
  it.each([undefined, fullUsage])('closes partial output without successful replay, with or without usage', usage => {
    const translator = new Translator('test-model', 'test-scope')
    translator.push({ type: 'response.output_item.added', output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    } as unknown as ResponseStreamEvent)
    translator.push({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' } as ResponseStreamEvent)
    const chunks = translator.push(terminal(type, usage))
    expect(chunks[0]).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } })
    expect(usages(chunks)).toHaveLength(usage ? 1 : 0)
    expectTerminal(chunks, type)
    expect(translator.close()).toEqual([])
  })

  it('does not attach replay even when output items were already completed', () => {
    const translator = new Translator('test-model', 'test-scope')
    translator.push({ type: 'response.output_item.done', output_index: 0, item: message } as unknown as ResponseStreamEvent)
    const chunks = translator.push(terminal(type, fullUsage))
    expect(chunks.map(chunk => chunk.type)).toEqual(['usage', 'finish'])
    expectTerminal(chunks, type)
  })
})

it('preserves non-token-limit incomplete errors without replay', () => {
  const chunks = new Translator('test-model', 'test-scope').push(terminal('response.incomplete', fullUsage, 'content_filter'))
  expect(usages(chunks)).toHaveLength(1)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'CHATGPT_PROVIDER_REQUEST_FAILED' } } })
  expect(chunks.at(-1)).not.toHaveProperty('replayState')
})

it('still rejects a completed response without valid output rather than creating successful replay', () => {
  const translator = new Translator('test-model', 'test-scope')
  const event = { type: 'response.completed', response: { output: [], usage: fullUsage } } as unknown as ResponseStreamEvent
  expect(() => translator.push(event)).toThrow(expect.objectContaining({ code: 'CHATGPT_PROVIDER_INVALID_DATA' }))
  expect(() => translator.finish()).toThrow('before a terminal response')
})
