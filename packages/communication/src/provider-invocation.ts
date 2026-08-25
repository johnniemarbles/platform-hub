import type { RoutedCommunicationConnector } from './dispatch-routing.ts';
import type {
  CommunicationProviderSendRequest,
  CommunicationProviderSendResult,
} from './provider-adapter.ts';
import type { CommunicationProviderAdapterRegistry } from './provider-adapter-registry.ts';

export type CommunicationProviderInvocationResult =
  | {
      readonly invoked: true;
      readonly adapterKey: string;
      readonly connectorKey: string;
      readonly result: CommunicationProviderSendResult;
    }
  | {
      readonly invoked: false;
      readonly reasonCode: 'PROVIDER_ADAPTER_UNAVAILABLE';
      readonly connectorKey: string;
      readonly providerKey: string;
    };

export async function invokeCommunicationProvider(input: {
  readonly connector: RoutedCommunicationConnector;
  readonly request: CommunicationProviderSendRequest;
  readonly registry: CommunicationProviderAdapterRegistry;
}): Promise<CommunicationProviderInvocationResult> {
  const adapter = input.registry.resolve({
    providerKey: input.connector.providerKey,
    channel: input.request.channel,
  });

  if (adapter === null) {
    return {
      invoked: false,
      reasonCode: 'PROVIDER_ADAPTER_UNAVAILABLE',
      connectorKey: input.connector.connectorKey,
      providerKey: input.connector.providerKey,
    };
  }

  const result = await adapter.send(input.request);
  return {
    invoked: true,
    adapterKey: adapter.adapterKey,
    connectorKey: input.connector.connectorKey,
    result,
  };
}
