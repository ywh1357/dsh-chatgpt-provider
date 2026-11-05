/** Account actions shared by the settings UI and DSH authorization flow. */
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationInteraction, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { KEY, type PlanAuth } from './auth.ts'
import type { AccountStatus, Options } from './types.ts'
import { Work } from './work.ts'

/** One owned background sign-in; callback URLs stay on the initiating UI. */
export class PlanRuntime {
  readonly work = new Work()
  private pending: Promise<unknown> | undefined
  private url: string | undefined
  private error: AccountStatus['error']
  private revocationUnconfirmed = false
  private submitCallback: ((value: string) => void) | undefined

  constructor(private readonly ctx: Context, private readonly auth: PlanAuth, private readonly options: Options, private readonly cancelRequests: () => void) {}

  /** Read display facts only; no token or ID-token hint leaves the Host. */
  async status(): Promise<AccountStatus> {
    const connection = await this.auth.connection()
    return {
      connected: connection !== undefined, pending: this.pending !== undefined,
      ...connection?.email === undefined ? {} : { email: connection.email },
      ...this.url === undefined ? {} : { authorizationUrl: this.url },
      ...this.error === undefined ? {} : { error: this.error },
      ...!this.revocationUnconfirmed ? {} : { revocationUnconfirmed: true },
    }
  }

  /** Start login and return when its authorization URL is available. */
  async begin(): Promise<AccountStatus> {
    this.work.signal()
    if (this.pending) throw new LlmError('A ChatGPT sign-in is already in progress.', 'CHATGPT_PROVIDER_LOGIN_IN_PROGRESS')
    this.error = undefined
    let ready!: () => void
    const announced = new Promise<void>(resolve => { ready = resolve })
    const interaction: AuthorizationInteraction = {
      notify: notice => { if (notice.url) { this.url = notice.url; ready() } },
      prompt: prompt => this.prompt(prompt),
    }
    this.pending = this.work.run(async signal => {
      try {
        await this.ctx.authorization.begin({ key: KEY, method: 'oauth', interaction, signal })
      } catch (error) {
        if (!signal.aborted) this.error = error instanceof LlmError && (error.code === 'CHATGPT_PROVIDER_CONSENT_DENIED' || error.code === 'CHATGPT_PROVIDER_CONSENT_REQUIRED') ? 'consent'
          : error instanceof LlmError && error.code === 'CHATGPT_PROVIDER_INVALID_DATA' ? 'identity' : 'signIn'
      } finally {
        this.url = undefined; this.pending = undefined; this.submitCallback = undefined
        ready()
      }
    })
    await announced
    return this.status()
  }

  private prompt(prompt: AuthorizationPrompt): Promise<string> {
    return new Promise((resolve, reject) => {
      const signal = prompt.signal
      const abort = () => { this.submitCallback = undefined; reject(signal?.reason ?? new Error('Login cancelled')) }
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
      this.submitCallback = value => { signal?.removeEventListener('abort', abort); this.submitCallback = undefined; resolve(value) }
    })
  }

  /** Finish the pending loopback flow from the full browser redirect URL. */
  async submit(value: string): Promise<AccountStatus> {
    if (typeof value !== 'string' || value.length > 16384 || !this.submitCallback) throw new LlmError('There is no pending ChatGPT callback to submit.', 'CHATGPT_PROVIDER_NO_LOGIN')
    this.submitCallback(value)
    await this.pending
    return this.status()
  }

  /** Cancel and await this plugin's login attempt. */
  async cancel(): Promise<AccountStatus> {
    await this.ctx.authorization.cancel(KEY)
    await this.pending
    return this.status()
  }

  /** Revoke the renewable session, retaining its registration for a later sign-in. */
  async logout(): Promise<AccountStatus> {
    await this.cancel()
    this.cancelRequests()
    await this.work.run(async lifetime => {
      this.revocationUnconfirmed = !await this.auth.logout(AbortSignal.any([lifetime, AbortSignal.timeout(this.options.requestTimeoutMs)]))
    })
    return this.status()
  }

  /** Stop UI work while its credentials and authorization dependencies still exist. */
  async close(): Promise<void> { await this.work.close() }
}
