/** Safe diagnostics at the network, credential and model interfaces. */
import { LlmError } from '@deepseek-ai/dsh-llm'

export function signInRequired(status = 401): LlmError {
  return new LlmError('ChatGPT authorization is no longer usable. Sign in again in ChatGPT plan settings.', 'CHATGPT_PROVIDER_SIGN_IN_REQUIRED', { status })
}

export function cancelled(): LlmError {
  return new LlmError('The ChatGPT request was cancelled or timed out; plan usage may have occurred.', 'CHATGPT_PROVIDER_CANCELLED')
}

/** Convert provider codes to fixed actionable text without echoing response bodies. */
export function providerError(code: string, status?: number): LlmError {
  const details = status === undefined ? undefined : { status }
  if (status === 503 || code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable') {
    return new LlmError('ChatGPT plan service is temporarily unavailable. Try again later.', 'CHATGPT_PROVIDER_UNAVAILABLE', details)
  }
  if (code === 'subscription_sharing_usage_limit_exceeded') {
    return new LlmError('A ChatGPT plan usage limit was reached. Review ChatGPT Settings > Usage.', 'CHATGPT_PROVIDER_LIMIT', details)
  }
  if (status === 401 || code === 'subscription_sharing_invalid_user') {
    return new LlmError('ChatGPT could not authorize this request. Check your selected account and plan access, then try again.', 'CHATGPT_PROVIDER_AUTH_REJECTED', details)
  }
  return new LlmError('The ChatGPT request failed. Check your connection and account access, then try again.', 'CHATGPT_PROVIDER_REQUEST_FAILED', details)
}

/** Refuse untrusted persisted or protocol data with a safe error. */
export function invalid(message: string): never {
  throw new LlmError(message, 'CHATGPT_PROVIDER_INVALID_DATA')
}
