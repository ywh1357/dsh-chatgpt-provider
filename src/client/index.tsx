/** Account controls contributed to the existing Models settings page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ChangeEvent } from 'react'
import { contribution } from './remote.ts'
import { en, zh, type Key } from './locales.ts'
import type { AccountStatus } from '../types.ts'

interface Result<T> { ok: boolean; value?: T; error?: { message: string } }
interface Remote {
  status(): Promise<Result<AccountStatus>>
  begin(): Promise<Result<AccountStatus>>
  submit(value: string): Promise<Result<AccountStatus>>
  cancel(): Promise<Result<AccountStatus>>
  logout(): Promise<Result<AccountStatus>>
}
interface Operations { call(method: 'status' | 'begin' | 'cancel' | 'logout'): Promise<AccountStatus>; submit(value: string): Promise<AccountStatus> }
interface Props { operations: Operations; t(key: Key): string }
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'chatgpt-provider': Key } }

const cardCss = `
.chatgpt-provider-card{box-sizing:border-box;border:.5px solid var(--dsw-alias-settings-card-stroke,#d5d5d5);border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-alias-settings-card-fill,transparent);color:var(--dsw-alias-label-primary,inherit);padding:12px 14px;font-size:14px;line-height:22px}
.chatgpt-provider-card .cp-head{display:flex;align-items:center;flex-wrap:wrap;gap:10px 12px}
.chatgpt-provider-card .cp-identity{flex:1 1 160px;min-width:0}
.chatgpt-provider-card .cp-heading{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.chatgpt-provider-card h3{margin:0;font-size:14px;font-weight:500;line-height:22px}
.chatgpt-provider-card .cp-status{display:inline-flex;align-items:center;gap:5px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#83868f)}
.chatgpt-provider-card .cp-status:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.chatgpt-provider-card[data-state=connected] .cp-status{color:var(--dsw-alias-state-success-primary,#14c562)}
.chatgpt-provider-card[data-state=pending] .cp-status{color:var(--dsw-alias-state-warn-label,#a77514)}
.chatgpt-provider-card .cp-account{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666a73);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chatgpt-provider-card .cp-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-shrink:0}
.chatgpt-provider-card .cp-link{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3,#d5d5d5);border-radius:var(--dsw-radius-sm,8px);color:inherit;font-size:12px;line-height:18px;text-decoration:none;white-space:nowrap}
.chatgpt-provider-card .cp-link:hover{background:var(--dsw-alias-interactive-bg-hover,#f0f1f3)}
.chatgpt-provider-card .cp-link:focus-visible,.chatgpt-provider-card summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2468f2);outline-offset:2px}
.chatgpt-provider-card .cp-more{min-width:28px;padding:0;font-size:20px}
.chatgpt-provider-card .cp-body{border-top:.5px solid var(--dsw-alias-border-l2,#ededed);margin-top:10px;padding-top:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666a73)}
.chatgpt-provider-card .cp-body p{margin:0 0 8px}
.chatgpt-provider-card .cp-settings-actions{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.chatgpt-provider-card .cp-signout{color:var(--dsw-alias-state-error-primary,#dc3545)}
.chatgpt-provider-card .cp-error{margin:10px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#dc3545);overflow-wrap:anywhere}
.chatgpt-provider-card .cp-warning{color:var(--dsw-alias-state-warn-label,#a77514)}
.chatgpt-provider-card summary{cursor:pointer;width:fit-content}
.chatgpt-provider-card .cp-callback{display:flex;align-items:flex-end;flex-wrap:wrap;gap:8px;margin-top:10px}
.chatgpt-provider-card .cp-callback label{display:flex;flex-direction:column;gap:6px;flex:1 1 180px;min-width:0}
.chatgpt-provider-card .cp-callback label>span{box-sizing:border-box;width:100%}
`

export const inject = ['slots', 'locale', 'remote']

/** Register one settings section and mount its Remote methods with the plugin lifetime. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('chatgpt-provider', { en, zh }))
  const mounted = ctx.remote.$mount(contribution())
  // Handle mount rejection immediately, even when the Models page has not opened.
  void mounted.catch(error => ctx.logger.warn('ChatGPT plan UI could not mount its Remote methods', error))
  const remote = async (): Promise<Remote> => {
    await mounted
    const value = ctx.get('remote.chatgptProvider') as Remote | undefined
    if (!value) throw new Error('ChatGPT plan Remote service is unavailable')
    return value
  }
  const unwrap = (result: Result<AccountStatus>): AccountStatus => {
    if (!result.ok || result.value === undefined) throw new Error('ChatGPT plan request failed')
    return result.value
  }
  const operations: Operations = {
    call: async method => unwrap(await (await remote())[method]()),
    submit: async value => unwrap(await (await remote()).submit(value)),
  }
  const t = ctx.locale.bind('chatgpt-provider')
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: 'chatgpt-provider', locale: 'chatgpt-provider',
    inject: () => ({ operations, t }),
  }, AccountCard))
}

/** Display account facts; credentials stay exclusively on the Host. */
export function AccountCard({ operations, t }: Props) {
  const [status, setStatus] = useState<AccountStatus>({ connected: false, pending: false })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [callback, setCallback] = useState('')
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    let live = true
    const load = () => operations.call('status').then(value => { if (live) { setStatus(value); setFailed(false) } }, () => { if (live) setFailed(true) })
    void load()
    const timer = setInterval(() => { void load() }, 2000)
    return () => { live = false; clearInterval(timer) }
  }, [operations])
  const act = async (operation: () => Promise<AccountStatus>) => {
    setBusy(true)
    try { setStatus(await operation()); setFailed(false) }
    catch (error) { void error; setFailed(true) }
    finally { setBusy(false) }
  }
  const accountState = status.pending ? 'pending' : status.connected ? 'connected' : 'signed-out'
  return <section className="chatgpt-provider-card" data-state={accountState} aria-label={t('title')} aria-busy={busy}>
    <style>{cardCss}</style>
    <div className="cp-head">
      <div className="cp-identity">
        <div className="cp-heading"><h3>{t('title')}</h3><span className="cp-status" role="status">{t(status.pending ? 'waiting' : status.connected ? 'connected' : 'signedOut')}</span></div>
        <p className="cp-account" title={status.email}>{status.email || t('description')}</p>
      </div>
      <div className="cp-actions">
        {status.pending ? <>
          {status.authorizationUrl && <a className="cp-link" href={status.authorizationUrl} target="_blank" rel="noreferrer">{t('open')}</a>}
          <Button size="sm" disabled={busy} onClick={() => void act(() => operations.call('cancel'))}>{t('cancel')}</Button>
        </> : <>
          {status.connected ? <a className="cp-link" href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer">{t('usage')}</a>
            : <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(() => operations.call('begin'))}>{t('signIn')}</Button>}
          <Button size="sm" variant="outline" className="cp-more" aria-label={t(expanded ? 'collapse' : 'manage')} title={t(expanded ? 'collapse' : 'manage')} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span aria-hidden="true">⋯</span></Button>
        </>}
      </div>
    </div>
    {failed && <p className="cp-error" role="alert">{t('failed')}</p>}
    {status.error && <p className="cp-error" role="alert">{t(status.error === 'signIn' ? 'signInError' : status.error)}</p>}
    {status.revocationUnconfirmed && <p className="cp-error cp-warning" role="status">{t('revoke')}</p>}
    {status.pending ? <details className="cp-body">
      <summary>{t('manual')}</summary>
      <div className="cp-callback">
        <label>{t('callback')}<Input value={callback} placeholder="http://127.0.0.1:…/auth/callback?…" onChange={(event: ChangeEvent<HTMLInputElement>) => setCallback(event.target.value)} /></label>
        <Button size="sm" variant="outline" disabled={busy || !callback} onClick={() => { void act(() => operations.submit(callback)); setCallback('') }}>{t('submit')}</Button>
      </div>
    </details> : expanded && <div className="cp-body">
      <p>{t('notice')}</p>
      <div className="cp-settings-actions">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => operations.call('status'))}>{t('refresh')}</Button>
        {status.connected && <Button size="sm" className="cp-signout" disabled={busy} onClick={() => void act(() => operations.call('logout'))}>{t('signOut')}</Button>}
      </div>
    </div>}
  </section>
}
