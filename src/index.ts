/** Installable ChatGPT plan provider for DSH's existing agent loop. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-credentials'
import { PlanAuth, KEY } from './auth.ts'
import { PlanAdapter, PROVIDER } from './adapter.ts'
import { PlanRuntime } from './runtime.ts'
import { PlanController } from './controller.ts'
import type { Options } from './types.ts'
import type {} from './diagnostics-plugin.ts'

export const name = 'chatgpt-provider'
export const inject = ['llm', 'credentials', 'authorization']
export const Config = z.object({
  loginTimeoutMs: z.number().step(1).min(1).max(2147483647).default(180000),
  requestTimeoutMs: z.number().step(1).min(1).max(2147483647).default(180000),
  authRequestTimeoutMs: z.number().step(1).min(1).max(20000).default(15000),
  refreshMarginMs: z.number().step(1).min(0).max(2147483647).default(180000),
  revocationRetries: z.number().step(1).min(0).max(5).default(1),
  revocationRetryDelayMs: z.number().step(1).min(1).max(2147483647).default(250),
  callbackPort: z.number().step(1).min(0).max(65535).default(1455),
  modelContextWindows: z.dict(z.number().step(1).min(1024)).default({}),
})
export type Config = Options

/** Register a provider, account flow and settings controller with one teardown owner. */
export function apply(ctx: Context, config: Config): void {
  const auth = new PlanAuth(ctx.credentials, config)
  const adapter = new PlanAdapter(auth, config, fetch, () => ctx.get('attachments'), () => ctx.get('chatgptDiagnostics'))
  const runtime = new PlanRuntime(ctx, auth, config, () => adapter.cancelRequests())
  ctx.effect(function* () {
    yield ctx.llm.registerAdapter([PROVIDER], adapter)
    yield ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: 'ChatGPT plan', settingsNs: name, settingsPath: [], nativeAuth: { env: [], oauth: true }, defaultBaseURL: 'https://api.openai.com/v1' }])
    yield ctx.authorization.registerFlow({ key: KEY, label: 'ChatGPT plan', methods: [{ id: 'oauth', label: 'Continue with ChatGPT' }], run: session => auth.login(session) })
    const controller = ctx.plugin((child: Context) => { new PlanController(child, runtime) })
    yield () => controller.dispose()
    yield async () => { await Promise.all([runtime.close(), adapter.work.close()]) }
  })
}
