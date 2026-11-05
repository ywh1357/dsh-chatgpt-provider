/** Typed Host entry points for the account card. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { PlanRuntime } from './runtime.ts'
import type { AccountStatus } from './types.ts'

export class PlanController extends TypertRemoteService {
  constructor(ctx: Context, private readonly runtime: PlanRuntime) { super(ctx, 'chatgptProviderController', { namespace: 'chatgptProvider' }) }
  /** Return account and authorization status without credentials. */
  @Remote async status(): Promise<AccountStatus> { return this.runtime.status() }
  /** Start the browser sign-in flow. */
  @Remote async begin(): Promise<AccountStatus> { return this.runtime.begin() }
  /** Submit a callback URL when the browser cannot reach the Host. */
  @Remote async submit(value: string): Promise<AccountStatus> { return this.runtime.submit(value) }
  /** Withdraw the pending authorization. */
  @Remote async cancel(): Promise<AccountStatus> { return this.runtime.cancel() }
  /** Clear the connected session and report unconfirmed remote revocation. */
  @Remote async logout(): Promise<AccountStatus> { return this.runtime.logout() }
}
