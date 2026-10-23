import type { CommunicationChannel } from './index.ts';
import type { CommunicationProviderAdapter } from './provider-adapter.ts';

export interface CommunicationProviderAdapterRegistry {
  resolve(input: {
    readonly providerKey: string;
    readonly channel: CommunicationChannel;
  }): CommunicationProviderAdapter | null;
}

export class StaticCommunicationProviderAdapterRegistry
  implements CommunicationProviderAdapterRegistry {
  readonly #adaptersByProviderKey: ReadonlyMap<string, CommunicationProviderAdapter>;

  constructor(entries: readonly {
    readonly providerKey: string;
    readonly adapter: CommunicationProviderAdapter;
  }[]) {
    const map = new Map<string, CommunicationProviderAdapter>();
    for (const entry of entries) {
      const key = normalizeProviderKey(entry.providerKey);
      if (map.has(key)) {
        throw new Error(`COMMUNICATION_PROVIDER_ADAPTER_DUPLICATE:${key}`);
      }
      map.set(key, entry.adapter);
    }
    this.#adaptersByProviderKey = map;
  }

  resolve(input: {
    readonly providerKey: string;
    readonly channel: CommunicationChannel;
  }): CommunicationProviderAdapter | null {
    const adapter = this.#adaptersByProviderKey.get(normalizeProviderKey(input.providerKey));
    if (adapter === undefined) return null;
    return adapter.supportedChannels.includes(input.channel) ? adapter : null;
  }
}

function normalizeProviderKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) throw new Error('COMMUNICATION_PROVIDER_KEY_REQUIRED');
  return normalized;
}
