import type { CommunicationChannel } from './index.js';
import type {
  CommunicationProviderAdapter,
  ProviderSendResult,
} from './provider-adapter.js';
import type { ProviderSendRequest } from './provider-send-request.js';

/**
 * PORTED PATTERN: BEMP's ProviderUnavailableAdapter
 * (apps/core/src/communication/providers/provider-unavailable.provider.ts
 *  and the try/catch fallback in provider-adapter.factory.ts `create()`).
 *
 * Target architecture §3 says to keep this verbatim, and the reason is worth
 * restating: if a provider key is not registered or config resolution fails,
 * the registry returns an explicit "unavailable" adapter that fails loudly
 * with a reason code. It never throws an unhandled exception into the send
 * pipeline, and it never silently drops the message.
 *
 * Silent failure is BEMP prohibition C9. A message that vanishes is worse
 * than a message that is refused, because nobody notices for days.
 */
export class ProviderUnavailableAdapter implements CommunicationProviderAdapter {
  readonly providerKey = 'unavailable';
  readonly channel: CommunicationChannel;
  private readonly requestedProviderKey: string;
  private readonly reason: string;

  constructor(input: {
    readonly requestedProviderKey: string;
    readonly channel: CommunicationChannel;
    readonly reason?: string;
  }) {
    this.requestedProviderKey = input.requestedProviderKey;
    this.channel = input.channel;
    this.reason =
      input.reason ??
      `No active communication provider is configured for channel '${input.channel}'.`;
  }

  async send(_request: ProviderSendRequest): Promise<ProviderSendResult> {
    return {
      state: 'REFUSED',
      reasonCode: 'PROVIDER_UNAVAILABLE',
      providerKey: this.providerKey,
      providerMessageId: null,
      refusalReason: this.reason,
      occurredAt: new Date().toISOString(),
    };
  }

  async testConnection(): Promise<{ readonly ok: false; readonly reason: string }> {
    return { ok: false, reason: this.reason };
  }

  describe(): { readonly requestedProviderKey: string; readonly reason: string } {
    return { requestedProviderKey: this.requestedProviderKey, reason: this.reason };
  }
}

/**
 * The registry wrapper. Construction failure degrades to an explicit
 * "unavailable" state instead of crashing the request — BEMP's factory
 * behaviour, expressed against EXPADIO's adapter interface.
 */
export function adapterOrUnavailable<T extends CommunicationProviderAdapter>(
  build: () => T,
  fallback: { readonly requestedProviderKey: string; readonly channel: CommunicationChannel },
): CommunicationProviderAdapter {
  try {
    return build();
  } catch (error) {
    return new ProviderUnavailableAdapter({
      requestedProviderKey: fallback.requestedProviderKey,
      channel: fallback.channel,
      reason: `Provider adapter could not be constructed: ${(error as Error).message}`,
    });
  }
}
