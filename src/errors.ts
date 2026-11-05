/** Safe diagnostics at the network, credential and model interfaces. */
import { LlmError } from '@deepseek-ai/dsh-llm'

/** Convert provider codes to fixed actionable text without echoing response bodies. */
export function providerError(code: string, status?: number): LlmError {
  const limit = code === 'subscription_sharing_usage_limit_exceeded' || code === 'subscription_sharing_usage_unavailable'
  const auth = status === 401 || code === 'invalid_grant'
  return new LlmError(
    limit ? 'ChatGPT plan usage is unavailable or at its limit. Review ChatGPT Settings > Usage.'
      : auth ? 'ChatGPT authorization is no longer usable. Sign in again in ChatGPT plan settings.'
        : 'The ChatGPT request failed. Check your connection and account access, then try again.',
    limit ? 'CHATGPT_PROVIDER_LIMIT' : auth ? 'CHATGPT_PROVIDER_SIGN_IN_REQUIRED' : 'CHATGPT_PROVIDER_REQUEST_FAILED',
    status === undefined ? undefined : { status },
  )
}

/** Refuse untrusted persisted or protocol data with a safe error. */
export function invalid(message: string): never {
  throw new LlmError(message, 'CHATGPT_PROVIDER_INVALID_DATA')
}
