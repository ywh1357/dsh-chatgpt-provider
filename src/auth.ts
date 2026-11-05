/** Official SIWC registration, protected storage, token rotation and revocation. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Options } from './types.ts'
import { invalid, providerError } from './errors.ts'

export const KEY = credentialKey('chatgpt-provider', 'connection')
export const RESOURCE = 'https://api.openai.com/v1'
export const ISSUER = 'https://auth.openai.com'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`
const registrationSchema = z.object({ clientId: z.string().min(1), subject: z.string().min(1), email: z.string().optional() })
const connectionSchema = registrationSchema.extend({
  epoch: z.uuid(), accessToken: z.string().min(1), refreshToken: z.string().min(1), idToken: z.string().min(1),
  expiresAt: z.number().finite(), earliestRefreshAt: z.number().finite().optional(), scopes: z.array(z.string()),
})
const stateSchema = z.object({
  version: z.literal(1), hostId: z.string().refine(value => value.startsWith('urn:uuid:') && z.uuid().safeParse(value.slice(9)).success),
  registration: registrationSchema.optional(), connection: connectionSchema.optional(),
})
export type Connection = z.infer<typeof connectionSchema>
type State = z.infer<typeof stateSchema>
const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(), token_type: z.literal('Bearer'),
  expires_in: z.number().positive().finite(), scope: z.string().optional(),
  earliest_refresh_at: z.union([z.number().finite().transform(seconds => seconds * 1000), z.iso.datetime().transform(value => Date.parse(value))]).optional(),
})

/** Network dependencies are injected by tests; production only uses official endpoints. */
export interface AuthNetwork {
  fetch: typeof fetch
  verifyKey: JWTVerifyGetKey
  now(): number
}

/** Production JWKS cache is per plugin instance, not process-global. */
export function authNetwork(): AuthNetwork {
  return { fetch, verifyKey: createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`)), now: Date.now }
}

function read(record: CredentialRecord | undefined): State | undefined {
  if (record === undefined) return undefined
  const checked = record.kind === 'grant' ? stateSchema.safeParse(record.payload) : undefined
  if (!checked?.success) invalid('ChatGPT plan credentials are invalid. Remove the plugin credential record and sign in again.')
  return checked.data
}

function stored(state: State): CredentialRecord { return { kind: 'grant', payload: state } }
const random = () => randomBytes(32).toString('base64url')

/** One plugin instance, backed by the DSH store's cross-process exclusive updates. */
export class PlanAuth {
  constructor(
    private readonly credentials: CredentialProvider,
    private readonly options: Options,
    private readonly network: AuthNetwork = authNetwork(),
  ) {}

  /** Persist this host's identity before starting OAuth. */
  async initialize(): Promise<void> {
    await this.credentials.modifyRecord(KEY, async record => {
      if (read(record) !== undefined) return undefined
      return stored({ version: 1, hostId: `urn:uuid:${randomUUID()}` })
    })
  }

  /** Read the saved connection without exposing it to the browser. */
  async connection(): Promise<Connection | undefined> {
    const hit = await this.credentials.readRecord(KEY)
    return read(hit)?.connection
  }

  /** Register or reauthorize one account, validate identity, then commit credentials. */
  async login(session: AuthorizationSession): Promise<void> {
    await this.initialize()
    const hit = await this.credentials.readRecord(KEY)
    const state = read(hit)!
    const stateValue = random(), nonce = random(), verifier = random()
    const signal = AbortSignal.any([session.signal, AbortSignal.timeout(this.options.loginTimeoutMs)])
    let redirect = ''
    const matchesCallback = (url: URL) => url.origin === new URL(redirect).origin
      && url.pathname === '/auth/callback' && url.searchParams.get('state') === stateValue
      && ['state', 'code', 'client_id', 'error'].every(key => url.searchParams.getAll(key).length <= 1)
    let accept: ((url: URL) => void) | undefined
    const callback = new Promise<URL>(resolve => { accept = resolve })
    const server = createServer((req, res) => {
      let url: URL
      try { url = new URL(req.url ?? '/', redirect) }
      catch (error) { void error; res.writeHead(400); res.end('Invalid callback URL.'); return }
      const valid = req.method === 'GET' && req.headers.host === new URL(redirect).host && matchesCallback(url)
      res.writeHead(valid ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(valid ? 'Authorization received. Return to DSH to check the result.' : 'Invalid authorization callback.')
      if (valid) accept?.(url)
    })
    const abort = () => server.closeAllConnections()
    try {
      server.listen(this.options.callbackPort, '127.0.0.1')
      await once(server, 'listening', { signal })
      signal.addEventListener('abort', abort, { once: true })
      const address = server.address()
      if (address === null || typeof address === 'string') invalid('Could not open the local ChatGPT callback.')
      redirect = `http://127.0.0.1:${address.port}/auth/callback`
      const url = new URL(`${ISSUER}/api/accounts/authorize`)
      url.search = new URLSearchParams({
        client_id: state.registration?.clientId ?? 'dynamic_agent_client',
        ...state.registration === undefined ? { agent_name_hint: 'DSH ChatGPT Provider' } : {},
        ext_agent_host_id: state.hostId, response_type: 'code', redirect_uri: redirect,
        resource: RESOURCE, scope: SCOPES, state: stateValue, nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      }).toString()
      session.notify({ message: 'Authorize this app to use your ChatGPT plan.', url: url.toString() })
      const manualController = new AbortController()
      try {
        const pasted = session.prompt({
          kind: 'text', message: 'If the browser cannot reach this host, paste its full callback URL.',
          placeholder: redirect, signal: AbortSignal.any([signal, manualController.signal]),
        }).then(value => {
          const returned = new URL(value)
          if (!matchesCallback(returned)) invalid('The pasted callback does not match this sign-in attempt.')
          return returned
        })
        const cancelled = new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true, signal: manualController.signal })
        })
        const returned = await Promise.race([callback, pasted, cancelled])
        if (returned.searchParams.has('error')) throw new LlmError('ChatGPT authorization was declined. You can sign in again.', 'CHATGPT_PROVIDER_CONSENT_DENIED')
        const clientId = returned.searchParams.get('client_id') ?? state.registration?.clientId
        if (!clientId || clientId === 'dynamic_agent_client' || (state.registration && clientId !== state.registration.clientId)) {
          invalid('OpenAI did not return the expected client registration. Sign in again.')
        }
        const code = returned.searchParams.get('code')
        if (!code) invalid('OpenAI did not return an authorization code.')
        const token = await this.token({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE }, signal)
        const connection = await this.validate(token, clientId, nonce, undefined, signal)
        if (state.registration && connection.subject !== state.registration.subject) invalid('The authorized account differs from this app registration.')
        const { subject, email } = connection
        signal.throwIfAborted()
        await session.commit(stored({ ...state, registration: { clientId, subject, ...email === undefined ? {} : { email } }, connection }))
      } finally { manualController.abort() }
    } finally {
      signal.removeEventListener('abort', abort)
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    }
  }

  private async token(fields: Record<string, string>, signal: AbortSignal) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.options.authRequestTimeoutMs)])
    const response = await this.network.fetch(`${ISSUER}/api/accounts/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields), signal: requestSignal, redirect: 'error',
    })
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(await response.json().catch(() => undefined))
      if (error.success && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.data.error)) {
        throw providerError('invalid_grant', response.status)
      }
      throw new LlmError('The ChatGPT token request failed. Check your connection and app registration, then try again.', 'CHATGPT_PROVIDER_TOKEN_REQUEST_FAILED', { status: response.status })
    }
    const value = tokenSchema.safeParse(await response.json())
    if (!value.success) invalid('OpenAI returned invalid OAuth credentials. Sign in again.')
    return value.data
  }

  private async validate(
    token: z.infer<typeof tokenSchema>, clientId: string, nonce: string | undefined,
    previous: Connection | undefined, signal: AbortSignal,
  ): Promise<Connection> {
    signal.throwIfAborted()
    const idToken = token.id_token ?? previous?.idToken
    if (!idToken) invalid('OpenAI did not return an ID token.')
    let identity: { subject: string; email?: string | undefined } | undefined = previous
    if (token.id_token !== undefined) {
      try {
        const { payload } = await jwtVerify(idToken, this.network.verifyKey, { issuer: ISSUER, audience: clientId, currentDate: new Date(this.network.now()) })
        if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.exp !== 'number'
          || (nonce !== undefined && payload.nonce !== nonce)
          || (previous !== undefined && previous.subject !== payload.sub)) invalid('ChatGPT returned an unexpected account identity.')
        const profile = z.object({ email: z.string().optional() }).safeParse(payload['https://api.openai.com/profile'])
        const email = typeof payload.email === 'string' ? payload.email : profile.success ? profile.data.email : undefined
        identity = { subject: payload.sub, ...email === undefined ? {} : { email } }
      } catch (error) {
        if (error instanceof LlmError) throw error
        invalid('ChatGPT identity verification failed. Sign in again.')
      }
    }
    if (!identity) invalid('ChatGPT identity is missing.')
    const scopes = token.scope?.split(/\s+/).filter(Boolean) ?? previous?.scopes ?? []
    if (!scopes.includes(PLAN_SCOPE)) throw new LlmError('ChatGPT plan use was not authorized. Sign in and allow plan usage.', 'CHATGPT_PROVIDER_CONSENT_REQUIRED')
    return {
      clientId, subject: identity.subject, ...identity.email === undefined ? {} : { email: identity.email },
      epoch: previous?.epoch ?? randomUUID(), accessToken: token.access_token, refreshToken: token.refresh_token, idToken,
      scopes, expiresAt: this.network.now() + token.expires_in * 1000,
      ...token.earliest_refresh_at === undefined ? {} : { earliestRefreshAt: token.earliest_refresh_at },
    }
  }

  /** Refresh under the store lock; a stale request cannot adopt a replacement login. */
  async usable(epoch: string, callerSignal: AbortSignal): Promise<Connection> {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.options.authRequestTimeoutMs)])
    let result: Connection | undefined
    let failure: unknown
    await this.credentials.modifyRecord(KEY, async record => {
      const state = read(record), current = state?.connection
      if (!state || !current || current.epoch !== epoch) throw providerError('', 401)
      signal.throwIfAborted()
      const now = this.network.now()
      if (current.expiresAt <= now && (current.earliestRefreshAt ?? 0) > now) {
        throw new LlmError('ChatGPT has not permitted token refresh yet. Wait before trying again.', 'CHATGPT_PROVIDER_REFRESH_NOT_READY', { providerRetryAfterMs: current.earliestRefreshAt! - now })
      }
      if (current.expiresAt > now + this.options.refreshMarginMs || (current.expiresAt > now && (current.earliestRefreshAt ?? 0) > now)) {
        result = current; return undefined
      }
      try {
        result = await this.validate(await this.token({ grant_type: 'refresh_token', client_id: current.clientId, refresh_token: current.refreshToken, resource: RESOURCE }, signal), current.clientId, undefined, current, signal)
        return stored({ ...state, connection: result })
      } catch (error) {
        failure = error
        if (!(error instanceof LlmError) || error.code !== 'CHATGPT_PROVIDER_SIGN_IN_REQUIRED') return undefined
        const { connection: discarded, ...retained } = state
        void discarded
        return stored(retained)
      }
    })
    if (failure !== undefined) throw failure
    if (!result) throw providerError('', 401)
    return result
  }

  /** Forget only the rejected token, preserving a newer login or refresh. */
  async invalidate(epoch: string, accessToken: string): Promise<void> {
    await this.credentials.modifyRecord(KEY, async record => {
      const state = read(record)
      if (!state?.connection || state.connection.epoch !== epoch || state.connection.accessToken !== accessToken) return undefined
      const { connection: discarded, ...retained } = state
      void discarded
      return stored(retained)
    })
  }

  /** Clear local tokens even when remote revocation cannot be confirmed. */
  async logout(callerSignal: AbortSignal): Promise<boolean> {
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.options.authRequestTimeoutMs)])
    let confirmed = true
    await this.credentials.modifyRecord(KEY, async record => {
      const state = read(record)
      if (!state?.connection) return undefined
      try {
        const discovery = await this.network.fetch(`${ISSUER}/.well-known/openid-configuration`, { signal, redirect: 'error' })
        const data = z.object({ revocation_endpoint: z.url() }).parse(await discovery.json())
        const endpoint = new URL(data.revocation_endpoint)
        if (endpoint.origin !== ISSUER) invalid('OpenAI returned an unexpected revocation endpoint.')
        const fields = { token: state.connection.refreshToken, token_type_hint: 'refresh_token', client_id: state.connection.clientId }
        for (let attempt = 0; attempt <= this.options.revocationRetries; attempt++) {
          try {
            const response = await this.network.fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), signal, redirect: 'error' })
            confirmed = response.ok
            if (response.status < 500) break
          } catch (error) { void error; confirmed = false }
          if (attempt < this.options.revocationRetries) await delay(this.options.revocationRetryDelayMs * 2 ** attempt, undefined, { signal })
        }
      } catch (error) { void error; confirmed = false }
      const { connection: discarded, ...retained } = state
      void discarded
      return stored(retained)
    })
    return confirmed
  }
}
