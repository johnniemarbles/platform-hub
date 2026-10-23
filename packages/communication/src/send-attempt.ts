import type { RoutedCommunicationConnector } from './dispatch-routing.ts';
import type {
  CommunicationDeliveryRecord,
  CommunicationDeliveryRepository,
} from './delivery-repository.ts';
import type { CommunicationProviderAdapterRegistry } from './provider-adapter-registry.ts';
import type { CommunicationProviderSendRequest, CommunicationProviderSendResult } from './provider-adapter.ts';
import {
  classifyCommunicationProviderOutcome,
  type CommunicationRetryPolicy,
} from './retry-policy.ts';

export type CommunicationSendAttemptResult =
  | {
      readonly outcome: 'PROVIDER_ADAPTER_UNAVAILABLE';
      readonly connectorKey: string;
      readonly providerKey: string;
    }
  | {
      readonly outcome: 'IDEMPOTENCY_ROUTE_MISMATCH';
      readonly delivery: CommunicationDeliveryRecord;
      readonly requestedConnectorKey: string;
      readonly requestedAdapterKey: string;
    }
  | {
      readonly outcome: 'ALREADY_PROCESSED';
      readonly delivery: CommunicationDeliveryRecord;
    }
  | {
      readonly outcome: 'ACCEPTED' | 'FAILED';
      readonly delivery: CommunicationDeliveryRecord;
      readonly providerResult: CommunicationProviderSendResult;
    }
  | {
      readonly outcome: 'RETRY';
      readonly delivery: CommunicationDeliveryRecord;
      readonly providerResult: CommunicationProviderSendResult;
      readonly delayMs: number;
      readonly nextAttempt: number;
    };

/**
 * Executes one idempotent provider-send attempt. A retry result is an
 * instruction for an external scheduler/queue; this function never sleeps or
 * schedules work itself.
 */
export async function executeCommunicationSendAttempt(input: {
  readonly connector: RoutedCommunicationConnector;
  readonly request: CommunicationProviderSendRequest;
  readonly registry: CommunicationProviderAdapterRegistry;
  readonly deliveryRepository: CommunicationDeliveryRepository;
  readonly retryPolicy: CommunicationRetryPolicy;
  readonly attemptedAt: string;
}): Promise<CommunicationSendAttemptResult> {
  const adapter = input.registry.resolve({
    providerKey: input.connector.providerKey,
    channel: input.request.channel,
  });
  if (adapter === null) {
    return {
      outcome: 'PROVIDER_ADAPTER_UNAVAILABLE',
      connectorKey: input.connector.connectorKey,
      providerKey: input.connector.providerKey,
    };
  }

  const delivery = await input.deliveryRepository.createOrGet({
    tenantId: input.request.tenantId,
    ...(input.request.organizationId === undefined
      ? {}
      : { organizationId: input.request.organizationId }),
    idempotencyKey: input.request.idempotencyKey,
    channel: input.request.channel,
    connectorKey: input.connector.connectorKey,
    adapterKey: adapter.adapterKey,
    requestedAt: input.request.requestedAt,
  });

  if (
    delivery.connectorKey !== input.connector.connectorKey
    || delivery.adapterKey !== adapter.adapterKey
  ) {
    return {
      outcome: 'IDEMPOTENCY_ROUTE_MISMATCH',
      delivery,
      requestedConnectorKey: input.connector.connectorKey,
      requestedAdapterKey: adapter.adapterKey,
    };
  }

  if (delivery.state !== 'PENDING') {
    return { outcome: 'ALREADY_PROCESSED', delivery };
  }

  let providerResult: CommunicationProviderSendResult;
  try {
    providerResult = await adapter.send(input.request);
  } catch (error) {
    providerResult = {
      status: 'RETRYABLE_FAILURE',
      reasonCode: 'PROVIDER_UNAVAILABLE',
      reason: error instanceof Error ? error.message : 'provider invocation failed',
    };
  }

  const decision = classifyCommunicationProviderOutcome({
    result: providerResult,
    currentAttempt: delivery.attemptCount,
    policy: input.retryPolicy,
  });

  if (decision.action === 'RETRY') {
    const updated = await input.deliveryRepository.recordAttempt({
      tenantId: delivery.tenantId,
      deliveryId: delivery.deliveryId,
      occurredAt: input.attemptedAt,
      reasonCode: decision.reasonCode,
      ...(providerResult.reason === undefined ? {} : { reason: providerResult.reason }),
    });
    return {
      outcome: 'RETRY',
      delivery: updated,
      providerResult,
      delayMs: decision.delayMs,
      nextAttempt: decision.nextAttempt,
    };
  }

  const targetState = decision.action === 'ACCEPT' ? 'ACCEPTED' : 'FAILED';
  const transitioned = await input.deliveryRepository.applyTransition({
    tenantId: delivery.tenantId,
    deliveryId: delivery.deliveryId,
    ...(providerResult.providerMessageId === undefined
      ? {}
      : { providerMessageId: providerResult.providerMessageId }),
    incrementAttempt: true,
    transition: {
      from: delivery.state,
      to: targetState,
      occurredAt: providerResult.acceptedAt ?? input.attemptedAt,
      reasonCode: providerResult.reasonCode,
      ...(providerResult.reason === undefined ? {} : { reason: providerResult.reason }),
    },
  });

  return {
    outcome: decision.action === 'ACCEPT' ? 'ACCEPTED' : 'FAILED',
    delivery: transitioned.delivery,
    providerResult,
  };
}
