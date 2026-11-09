import { afterEach, expect, it } from 'vitest'
import { request } from 'node:http'
import { PlanAuth, KEY } from '../src/auth.ts'
import { deferred, fixture, options } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())) })
async function setup() { const f = await fixture(); cleanups.push(f.cleanup); return f }

it.each(['post', 'host', 'duplicate-state'] as const)('ignores an invalid %s callback and still accepts the valid browser redirect', async mode => {
  const f = await setup()
  await f.login(async callback => {
    const target = new URL(callback)
    if (mode === 'duplicate-state') target.searchParams.append('state', 'other-state')
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(target, {
        method: mode === 'post' ? 'POST' : 'GET',
        headers: mode === 'host' ? { host: 'attacker.test' } : {},
      }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)) })
      req.once('error', reject)
      req.end()
    })
    expect(status).toBe(400)
    expect(await f.auth.connection()).toBeUndefined()
  })
  expect((await f.auth.connection())?.subject).toBe('user-1')
})

it('persists a stable host and reuses the issued client registration after logout', async () => {
  const f = await setup()
  const first = await f.login()
  expect(first.searchParams.get('client_id')).toBe('dynamic_agent_client')
  expect(first.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/)
  expect((await f.auth.connection())?.subject).toBe('user-1')
  expect(await f.auth.logout(new AbortController().signal)).toBe(true)
  expect(await f.auth.connection()).toBeUndefined()
  const second = await f.login()
  expect(second.searchParams.get('client_id')).toBe('oaiapp_test')
  expect(second.searchParams.get('ext_agent_host_id')).toBe(first.searchParams.get('ext_agent_host_id'))
  expect(second.searchParams.has('agent_name_hint')).toBe(false)
})

it.each(['missing-scope', 'bad-signature', 'wrong-nonce', 'wrong-audience'] as const)('rejects %s before storing a connection', async mode => {
  const f = await setup(); f.setMode(mode)
  await expect(f.login()).rejects.toThrow()
  expect(await f.auth.connection()).toBeUndefined()
})

it('serializes concurrent refreshes from two auth instances using the actual DSH store', async () => {
  const f = await setup(); await f.login()
  const original = (await f.auth.connection())!
  f.advance(3500000)
  const other = new PlanAuth(f.ctx.credentials, options, f.network)
  const signal = new AbortController().signal
  const [a, b] = await Promise.all([f.auth.usable(original.epoch, signal), other.usable(original.epoch, signal)])
  expect(f.refreshes()).toBe(1)
  expect(a.refreshToken).toBe('refresh-1')
  expect(b.refreshToken).toBe(a.refreshToken)
})

it('does not let a request bound to an old login adopt another connection', async () => {
  const f = await setup(); await f.login()
  const old = (await f.auth.connection())!
  await f.auth.logout(new AbortController().signal)
  await f.login()
  await expect(f.auth.usable(old.epoch, new AbortController().signal)).rejects.toMatchObject({ code: 'CHATGPT_PROVIDER_SIGN_IN_REQUIRED' })
})

it.each(['network', '503', 'invalid-client'])('can refresh without signing in again after a %s refresh failure', async failure => {
  const f = await setup(); await f.login()
  const connection = (await f.auth.connection())!
  f.advance(3500000)
  const auth = new PlanAuth(f.ctx.credentials, options, { ...f.network, fetch: async () => {
    if (failure === 'network') throw new Error('network lost')
    return Response.json({ error: failure === '503' ? 'temporarily_unavailable' : 'invalid_client' }, { status: failure === '503' ? 503 : 400 })
  } })
  await expect(auth.usable(connection.epoch, new AbortController().signal)).rejects.toThrow()
  expect(await f.auth.connection()).toBeDefined()
  expect((await f.auth.usable(connection.epoch, new AbortController().signal)).accessToken).toBe('access-1')
})

it.each(['cancel', 'timeout'])('can refresh without signing in again after a refresh %s', async failure => {
  const f = await setup(); await f.login()
  const connection = (await f.auth.connection())!
  f.advance(3500000)
  const caller = new AbortController(), entered = deferred<void>()
  const auth = new PlanAuth(f.ctx.credentials, { ...options, authRequestTimeoutMs: failure === 'timeout' ? 500 : 5000 }, {
    ...f.network, fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      entered.resolve()
    }),
  })
  const observed = auth.usable(connection.epoch, caller.signal).catch(error => error)
  await entered.promise
  if (failure === 'cancel') caller.abort()
  expect(await observed).toBeInstanceOf(DOMException)
  expect(await f.auth.connection()).toBeDefined()
  expect((await f.auth.usable(connection.epoch, new AbortController().signal)).accessToken).toBe('access-1')
})

it.each(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])('requires sign-in after a confirmed %s refresh failure', async code => {
  const f = await setup(); await f.login()
  const connection = (await f.auth.connection())!
  f.advance(3500000)
  const auth = new PlanAuth(f.ctx.credentials, options, { ...f.network, fetch: async () => Response.json({ error: code }, { status: 400 }) })
  await expect(auth.usable(connection.epoch, new AbortController().signal)).rejects.toMatchObject({ code: 'CHATGPT_PROVIDER_SIGN_IN_REQUIRED' })
  expect(await auth.connection()).toBeUndefined()
})

it('reports unconfirmed remote revocation while removing local tokens', async () => {
  const f = await setup(); await f.login()
  const auth = new PlanAuth(f.ctx.credentials, options, { ...f.network, fetch: async () => { throw new Error('offline') } })
  expect(await auth.logout(new AbortController().signal)).toBe(false)
  expect(await f.auth.connection()).toBeUndefined()
})

it.each(['iso', 'seconds'])('honors an earliest-refresh time encoded as %s', async format => {
  const f = await setup()
  const earliest = Date.now() + 4000000
  f.setEarliest(format === 'iso' ? new Date(earliest).toISOString() : earliest / 1000)
  await f.login()
  const connection = (await f.auth.connection())!
  f.advance(3500000)
  await f.auth.usable(connection.epoch, new AbortController().signal)
  await f.auth.checkRejected(connection, new AbortController().signal)
  expect(f.refreshes()).toBe(0)
  f.advance(200000)
  await expect(f.auth.usable(connection.epoch, new AbortController().signal)).rejects.toMatchObject({ code: 'CHATGPT_PROVIDER_REFRESH_NOT_READY' })
  expect(f.refreshes()).toBe(0)
  expect(await f.auth.connection()).toBeDefined()
})

it('notifies model selectors through credential updates on sign-in and sign-out', async () => {
  const f = await setup()
  const updated: string[] = []
  f.ctx.on('credentials/record-updated', key => { updated.push(key) })
  await f.login()
  expect(updated).toContain(KEY)
  updated.length = 0
  await f.auth.logout(new AbortController().signal)
  expect(updated).toContain(KEY)
})
