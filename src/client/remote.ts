/** Browser descriptors for this out-of-tree plugin's Host Remote methods. */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

/** This list is checked against the decorated controller in the integration test. */
export function contribution(): TypertRemoteContribution {
  return {
    package: 'dsh-chatgpt-provider',
    descriptors: ['status', 'begin', 'submit', 'cancel', 'logout'].map(method => ({
      id: `dsh-chatgpt-provider#chatgptProvider/${method}`, service: 'chatgptProviderController', namespace: 'chatgptProvider', method,
      invocation: { kind: 'direct' as const },
      parameters: method !== 'submit' ? [] : [{ name: 'value', wire: 'value', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: 'dsh-chatgpt-provider#callback', create: () => ({ parse: (value: unknown) => {
        if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid callback URL')
        return value
      } }) } }],
      result: { mode: 'src-json' as const }, sourceLocation: { file: 'src/controller.ts', line: 1, column: 1 },
    })),
  }
}
