import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import Authorization from '@deepseek-ai/dsh-authorization'
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose'
import { AttachmentId, ImageVariantId, type RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { KEY, ISSUER, PlanAuth, type AuthNetwork } from '../src/auth.ts'
import type { Options } from '../src/types.ts'

export const options: Options = { loginTimeoutMs: 5000, requestTimeoutMs: 5000, authRequestTimeoutMs: 5000, refreshMarginMs: 180000, revocationRetries: 1, revocationRetryDelayMs: 1, callbackPort: 0, modelContextWindows: {} }
export const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLdcAAAAASUVORK5CYII=', 'base64')
export const imageRef = { attachmentId: AttachmentId('test-image'), mediaType: 'image/png' as const, bytes: imageBytes.length, width: 1, height: 1, name: 'pixel.png' }
export const imageVersion: RequestImageAttachment = { variantId: ImageVariantId('test-variant'), attachment: imageRef, data: imageBytes, mediaType: 'image/png', bytes: imageBytes.length, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true }
export const imageURL = `data:image/png;base64,${imageBytes.toString('base64')}`
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of stream) values.push(value)
  return values
}

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-provider-test-'))
  const ctx = new Context()
  await ctx.plugin(Credentials, { path: join(directory, 'credentials.yaml'), watch: false })
  await ctx.plugin(Authorization)
  const keys = await generateKeyPair('RS256')
  const publicJwk = await exportJWK(keys.publicKey)
  const verifyKey = createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test', alg: 'RS256' }] })
  let now = Date.now()
  let refreshes = 0
  const signed = async (clientId: string, nonce?: string, subject = 'user-1') => new SignJWT({
    ...(nonce === undefined ? {} : { nonce }), 'https://api.openai.com/profile': { email: 'user@example.test' },
  }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(ISSUER).setAudience(clientId).setSubject(subject).setIssuedAt().setExpirationTime(Math.floor(now / 1000) + 3600).sign(keys.privateKey)
  let activeNonce = ''
  let earliest: string | number | undefined
  let mode: 'ok' | 'missing-scope' | 'bad-signature' | 'wrong-nonce' | 'wrong-audience' = 'ok'
  const network: AuthNetwork = {
    now: () => now, verifyKey,
    fetch: async (url, init) => {
      if (String(url).endsWith('/.well-known/openid-configuration')) return Response.json({ revocation_endpoint: `${ISSUER}/revoke` })
      if (String(url).endsWith('/revoke')) return new Response(null, { status: 200 })
      const body = new URLSearchParams(String(init?.body))
      if (body.get('grant_type') === 'refresh_token') refreshes++
      const clientId = body.get('client_id')!
      let id = await signed(mode === 'wrong-audience' ? 'other-client' : clientId, mode === 'wrong-nonce' ? 'other-nonce' : activeNonce)
      if (mode === 'bad-signature') { const parts = id.split('.'); parts[2] = 'bad'; id = parts.join('.') }
      return Response.json({ access_token: `access-${refreshes}`, refresh_token: `refresh-${refreshes}`, id_token: id, token_type: 'Bearer', expires_in: 3600, scope: mode === 'missing-scope' ? 'openid' : 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', ...earliest === undefined ? {} : { earliest_refresh_at: earliest } })
    },
  }
  const auth = new PlanAuth(ctx.credentials, options, network)
  const login = async (probe?: (callback: URL) => Promise<void>) => {
    const announced = deferred<URL>()
    const abort = new AbortController()
    const session: AuthorizationSession = {
      method: 'oauth', signal: abort.signal,
      commit: async record => { await ctx.credentials.modifyRecord(KEY, async () => record) },
      notify: notice => { if (notice.url) { const url = new URL(notice.url); activeNonce = url.searchParams.get('nonce')!; announced.resolve(url) } },
      prompt: prompt => new Promise((_, reject) => {
        prompt.signal?.addEventListener('abort', () => reject(prompt.signal!.reason), { once: true })
      }),
    }
    const finished = auth.login(session)
    void finished.catch(() => {})
    const url = await announced.promise
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({ code: 'test-code', state: url.searchParams.get('state')!, client_id: 'oaiapp_test' }).toString()
    try {
      await probe?.(callback)
      await fetch(callback)
      await finished
      return url
    } finally {
      abort.abort()
      await finished.catch(() => {})
    }
  }
  return { ctx, auth, network, login, signed, keys,
    setMode: (value: typeof mode) => { mode = value },
    setEarliest: (value: string | number) => { earliest = value },
    advance: (ms: number) => { now += ms }, refreshes: () => refreshes,
    cleanup: async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) },
  }
}

export function wireFetch(output: object[], requests: { body: unknown; authorization: string | null }[]): typeof fetch {
  return async (url, init) => {
    const headers = new Headers(init?.headers)
    if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'test-model', display_name: 'Test model', visibility: 'list', context_window: 64000, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'high' }] }] })
    requests.push({ body: JSON.parse(String(init?.body)), authorization: headers.get('authorization') })
    const events = output.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    return new Response(events, { headers: { 'content-type': 'text/event-stream' } })
  }
}

export const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
export const textEvents = [
  { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
  { type: 'response.output_text.delta', output_index: 0, delta: 'hel' },
  { type: 'response.output_text.delta', output_index: 0, delta: 'lo' },
  { type: 'response.output_item.done', output_index: 0, item: message },
  { type: 'response.completed', response: { output: [message], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 0 } } } },
]
