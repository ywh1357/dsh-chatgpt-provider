/** Exercise the published package entry through the actual Cordis Loader. */
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { BlockAssembler, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { PlanController } from '../src/controller.ts'
import { contribution } from '../src/client/remote.ts'
import { KEY } from '../src/auth.ts'
import { fixture, imageRef, imageURL, imageVersion, textEvents, wireFetch } from './helpers.ts'

class TestAttachments extends Service {
  constructor(ctx: Context) { super(ctx, 'attachments') }
  async readImageRequest() { return imageVersion }
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.unstubAllGlobals() })

it('loads a real cordis.yml, serves a model request, and removes all registrations on unload', async () => {
  const f = await fixture(); cleanup.push(f.cleanup); await f.login()
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-provider-loader-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'cordis.yml')
  await writeFile(path, `- id: llm\n  name: '@deepseek-ai/dsh-llm'\n- id: credentials\n  name: '@deepseek-ai/dsh-credentials-local'\n  config:\n    path: ${JSON.stringify(join(directory, 'credentials.yaml'))}\n    watch: false\n- id: authorization\n  name: '@deepseek-ai/dsh-authorization'\n- id: chatgpt-provider\n  name: dsh-chatgpt-provider\n  config:\n    callbackPort: 0\n`)
  const captureDirectory = join(directory, 'diagnostics')
  await writeFile(path, (await readFile(path, 'utf8')) + `- id: siwc-cache-diagnostics\n  name: dsh-chatgpt-provider/diagnostics\n  config:\n    enabled: true\n    directory: ${JSON.stringify(captureDirectory)}\n    expiresAt: ${JSON.stringify(new Date(Date.now() + 3600000).toISOString())}\n`)
  const requests: { body: unknown; authorization: string | null }[] = []
  vi.stubGlobal('fetch', wireFetch(textEvents, requests))
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const unsupported = (): never => { throw new Error('Unexpected module-loader operation') }
  const internal: ModuleLoaderV2 = { version: 'v2', loadCache: new Map(), import: specifier => import(specifier), register: unsupported, getOrCreateModuleJob: unsupported, resolveSync: unsupported, load: unsupported }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  expect(ctx.llm.listProviders()).toContainEqual({ id: 'chatgpt-provider', name: 'ChatGPT plan' })
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'chatgpt-provider')!
  expect(ctx.authorization.describe(KEY)?.methods).toEqual([{ id: 'oauth', label: 'Continue with ChatGPT' }])
  const saved = await f.ctx.credentials.readRecord(KEY)
  await ctx.credentials.modifyRecord(KEY, async () => saved)
  const controller = ctx.get('chatgptProviderController') as PlanController
  expect(remoteMethods(controller).map(method => method.method)).toEqual(contribution().descriptors.map(d => d.method))
  expect(JSON.stringify(await controller.status())).not.toMatch(/access-0|refresh-0|idToken/)
  const sessionId = 'session-loader' as NonNullable<GenerateOptions['sessionId']>
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider: 'chatgpt-provider', model: 'test-model', sessionId, messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })] })) assembler.push(chunk)
  expect(assembler.blocks()).toEqual([{ type: 'text', text: 'hello' }])
  expect(assembler.finish).toEqual({ kind: 'stop' })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.body).toHaveProperty('prompt_cache_key', expect.any(String))
  await ctx.plugin(TestAttachments)
  const pictured = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider: 'chatgpt-provider', model: 'test-model', sessionId, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: imageRef }] })] })) pictured.push(chunk)
  expect(pictured.finish).toEqual({ kind: 'stop' })
  expect(requests[1]?.body).toMatchObject({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: imageURL, detail: 'auto' }] }] })
  expect(requests[1]?.body).toHaveProperty('prompt_cache_key', (requests[0]?.body as { prompt_cache_key: string }).prompt_cache_key)
  await entry.fiber?.dispose()
  expect(ctx.llm.listProviders()).toEqual([])
  expect(ctx.authorization.describe(KEY)).toBeUndefined()
  expect(ctx.get('chatgptProviderController')).toBeUndefined()
  const diagnosticEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'siwc-cache-diagnostics')!
  await diagnosticEntry.fiber?.dispose()
  expect(ctx.get('chatgptDiagnostics')).toBeUndefined()
  const files = await readdir(captureDirectory)
  expect(files).toHaveLength(1)
  const recording = await readFile(join(captureDirectory, files[0]!), 'utf8')
  const records = recording.trim().split('\n').map(line => JSON.parse(line))
  expect(records.filter(row => row.kind === 'request')).toHaveLength(2)
  expect(records[1]).toMatchObject({ usage: { value: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 } } }, normalizedUsage: { inputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 0 } })
  expect(recording).not.toMatch(/access-0|refresh-0|data:image|pixel.png|\"hello\"/)
})
