/** Lossless Responses history with account-scoped replay validation. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ResponseInputItem, ResponseInputImage, ResponseInputText, ResponseOutputItem, ResponseCreateParamsStreaming } from 'openai/resources/responses/responses'
import type { ContentBlock, GenerateOptions, ImageBlock, ReplayEnvelope, RequestMessage } from '@deepseek-ai/dsh-llm'
import { LlmError, ToolCallId, offloadedImageText } from '@deepseek-ai/dsh-llm'
import { invalid } from './errors.ts'

/** Efforts supported by the installed Responses SDK. */
export const effortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

const textPart = z.object({ type: z.literal('output_text'), text: z.string(), annotations: z.array(z.unknown()).default([]) }).passthrough()
const refusalPart = z.object({ type: z.literal('refusal'), refusal: z.string() }).passthrough()
const messageItem = z.object({
  type: z.literal('message'), id: z.string(), role: z.literal('assistant'), status: z.literal('completed'),
  content: z.array(z.union([textPart, refusalPart])), phase: z.enum(['commentary', 'final_answer', 'partial_answer']).nullable().optional(),
}).passthrough()
const reasoningItem = z.object({
  type: z.literal('reasoning'), id: z.string(),
  summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() })).default([]),
  encrypted_content: z.string().nullable().optional(),
}).passthrough()
const callItem = z.object({
  type: z.literal('function_call'), id: z.string().optional(), call_id: z.string().min(1), name: z.string().min(1),
  arguments: z.string(), namespace: z.literal('dsh').optional(), status: z.literal('completed').optional(),
}).passthrough()
export const itemSchema = z.union([messageItem, reasoningItem, callItem])
export type NativeItem = z.infer<typeof itemSchema>

/** One complete native item corresponds to one durable DSH block. */
export function blockOf(item: NativeItem): ContentBlock {
  switch (item.type) {
    case 'message': return { type: 'text', text: item.content.map(p => p.type === 'refusal' ? p.refusal : p.text).join('') }
    case 'reasoning': return { type: 'reasoning', text: item.summary.map(p => p.text).join('') }
    case 'function_call': return { type: 'tool-call', id: ToolCallId(item.call_id), name: item.name, arguments: item.arguments }
  }
}

function fingerprint(block: ContentBlock): string { return createHash('sha256').update(JSON.stringify(block)).digest('hex') }
const replaySchema = z.object({
  response: z.object({ kind: z.literal('chatgpt-provider'), version: z.literal(1), scope: z.string(), model: z.string(), count: z.number().int() }),
  blocks: z.array(z.object({ item: itemSchema, hash: z.string() })),
})

/** Persist only validated native response items and their visible-content fingerprints. */
export function replay(items: NativeItem[], model: string, scope: string): ReplayEnvelope {
  return {
    response: { kind: 'chatgpt-provider', version: 1, scope, model, count: items.length },
    blocks: items.map(item => ({ item, hash: fingerprint(blockOf(item)) })),
  }
}

function nativeHistory(message: RequestMessage, model: string, scope: string): NativeItem[] | undefined {
  if (message.role !== 'assistant' || message.source.kind !== 'model') return undefined
  const checked = replaySchema.safeParse(message.source.replayState)
  if (!checked.success) return undefined
  const { response, blocks } = checked.data
  if (response.scope !== scope || response.model !== model || response.count !== blocks.length || blocks.length !== message.content.length) return undefined
  if (!blocks.every((b, i) => b.hash === fingerprint(message.content[i]!) && b.hash === fingerprint(blockOf(b.item)))) return undefined
  return blocks.map(b => b.item)
}

type ImageReader = (block: ImageBlock) => Promise<ResponseInputImage>

/** Keep mixed text and image order, honoring DSH's durable offload decisions. */
async function imageParts(blocks: readonly ContentBlock[], readImage?: ImageReader): Promise<(ResponseInputText | ResponseInputImage)[]> {
  const parts: (ResponseInputText | ResponseInputImage)[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push({ type: 'input_text', text: block.text })
    else if (block.type === 'image') {
      if (block.offloaded) parts.push({ type: 'input_text', text: offloadedImageText(block.attachment) })
      else {
        if (!readImage) invalid('A DSH attachment reader is required to send images.')
        parts.push(await readImage(block))
      }
    } else invalid('ChatGPT received an unsupported block in image content.')
  }
  return parts
}

/** Serialize only supported SIWC inputs; never silently omit an unsupported request option. */
export async function requestBody(options: GenerateOptions, scope: string, readImage?: ImageReader): Promise<ResponseCreateParamsStreaming> {
  if (options.stop !== undefined || options.temperature !== undefined || options.maxTokens !== undefined) {
    throw new LlmError('ChatGPT plan requests do not support stop, temperature or output-token limits.', 'UNSUPPORTED_OPTION')
  }
  const input: ResponseInputItem[] = []
  if (options.system !== undefined) input.push({ role: 'developer', content: options.system })
  for (const message of options.messages) {
    const restored = nativeHistory(message, options.model, scope)
    if (restored !== undefined) { input.push(...restored as ResponseInputItem[]); continue }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content.some(b => b.type === 'image') ? await imageParts(message.content, readImage) : message.content.map(b => b.type === 'text' ? b.text : '').join('') })
      continue
    }
    if (message.role === 'user' && message.content.some(b => b.type === 'image')) {
      input.push({ role: 'user', content: await imageParts(message.content, readImage) })
      continue
    }
    let text = ''
    const flush = () => {
      if (!text) return
      if (message.role === 'assistant') input.push({ type: 'message', id: message.id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
      else input.push({ role: message.role === 'system' ? 'developer' : message.role, content: text })
      text = ''
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text': text += block.text; break
        case 'reasoning': break // Visible summaries alone cannot reconstruct native encrypted reasoning.
        case 'tool-call':
          flush()
          input.push({ type: 'function_call', call_id: block.id, name: block.name, namespace: 'dsh', arguments: block.arguments })
          break
        case 'image': case 'file':
          throw new LlmError('ChatGPT accepts images in user messages and tool results; other attachments must be text-projected by DSH.', 'UNSUPPORTED_OPTION')
        default: invalid('ChatGPT plan received an unsupported message block.')
      }
    }
    flush()
  }
  const effort = options.reasoningEffort
  const allowedEffort = effortSchema.optional().parse(effort)
  return {
    model: options.model, input, store: false, stream: true, include: ['reasoning.encrypted_content'],
    ...options.sessionId === undefined ? {} : { prompt_cache_key: createHash('sha256').update(String(options.sessionId)).digest('hex') },
    ...allowedEffort === undefined ? {} : { reasoning: { effort: allowedEffort } },
    ...!options.tools?.length ? {} : {
      tools: [{ type: 'namespace', name: 'dsh', description: 'Tools executed by DeepSeek Harness.', tools: options.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })) }],
    },
  }
}

/** Validate the complete output snapshot before allowing durable native replay. */
export function nativeItem(item: ResponseOutputItem): NativeItem {
  const checked = itemSchema.safeParse(item)
  if (!checked.success) invalid('OpenAI returned an unsupported or incomplete response item.')
  return checked.data
}
