/** Separately enabled diagnostic service. Installing the main provider alone never enables recording. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Diagnostics, type DiagnosticOptions, type DiagnosticSink } from './diagnostics.ts'
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses'

declare module '@deepseek-ai/cordis' { interface Context { chatgptDiagnostics: ChatgptDiagnostics } }
export const name = 'chatgpt-diagnostics'
export const Config = z.object({
  enabled: z.boolean().default(false),
  directory: z.string().default(''),
  expiresAt: z.string().default(''),
  maxRequests: z.number().step(1).min(1).max(200).default(32),
  maxFileBytes: z.number().step(1).min(4096).max(10485760).default(1048576),
})
export type Config = DiagnosticOptions

export class ChatgptDiagnostics extends Service implements DiagnosticSink {
  constructor(ctx: Context, private readonly recorder: Diagnostics) { super(ctx, 'chatgptDiagnostics') }
  /** Called only by the SIWC adapter; no credentials are accepted. */
  begin(body: ResponseCreateParamsStreaming, scope: string, session?: string) { return this.recorder.begin(body, scope, session) }
}

/** An optional, independently disposable capability; it never registers or calls an LLM. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const recorder = new Diagnostics(config, () => ctx.logger.warn('SIWC diagnostics stopped because of a recording limit or I/O failure; model requests are unaffected.'))
  ctx.effect(() => () => recorder.close())
  await recorder.open()
  new ChatgptDiagnostics(ctx, recorder)
}
