/** Public, credential-free account information displayed by the settings card. */
export interface AccountStatus {
  connected: boolean
  email?: string
  pending: boolean
  authorizationUrl?: string
  error?: 'consent' | 'identity' | 'signIn'
  revocationUnconfirmed?: boolean
}

/** Validated deployment settings; protocol endpoints are fixed by SIWC. */
export interface Options {
  loginTimeoutMs: number
  requestTimeoutMs: number
  authRequestTimeoutMs: number
  refreshMarginMs: number
  revocationRetries: number
  revocationRetryDelayMs: number
  callbackPort: number
  modelContextWindows: Record<string, number>
}
