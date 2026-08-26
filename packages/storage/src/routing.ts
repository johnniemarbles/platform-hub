import {
  routeConnector,
  type ConnectorDefinition,
  type RoutingPolicy,
} from '@platform-hub/provider-registry';
import {
  validateObjectStorageIntent,
  validateObjectStorageObservation,
  type ObjectStorageGateway,
  type ObjectStorageIntent,
  type ObjectStorageObservation,
  type ObjectStorageOperation,
} from './index.ts';

export interface ObjectStorageProviderAdapter {
  execute(input: {
    readonly intent: ObjectStorageIntent;
    /** Managed credential reference only; never raw secret material. */
    readonly connector: ConnectorDefinition;
  }): Promise<ObjectStorageObservation>;
}

export type RoutedObjectStorageErrorCode =
  | 'STORAGE_INTENT_INVALID'
  | 'STORAGE_CONNECTOR_UNAVAILABLE'
  | 'STORAGE_CREDENTIAL_REFERENCE_REQUIRED'
  | 'STORAGE_ADAPTER_NOT_REGISTERED'
  | 'STORAGE_OBSERVATION_INVALID'
  | 'STORAGE_CONNECTOR_PROVENANCE_MISMATCH';

export class RoutedObjectStorageError extends Error {
  readonly code: RoutedObjectStorageErrorCode;

  constructor(code: RoutedObjectStorageErrorCode, message: string) {
    super(message);
    this.name = 'RoutedObjectStorageError';
    this.code = code;
  }
}

export class RoutedObjectStorageGateway
implements ObjectStorageGateway {
  readonly #connectors: readonly ConnectorDefinition[];
  readonly #adapters:
    ReadonlyMap<string, ObjectStorageProviderAdapter>;
  readonly #policies: readonly RoutingPolicy[];

  constructor(input: {
    readonly connectors: readonly ConnectorDefinition[];
    readonly adapters:
      ReadonlyMap<string, ObjectStorageProviderAdapter>;
    readonly policies?: readonly RoutingPolicy[];
  }) {
    this.#connectors = input.connectors;
    this.#adapters = input.adapters;
    this.#policies = input.policies ?? [];
  }

  async execute(
    intent: ObjectStorageIntent,
  ): Promise<ObjectStorageObservation> {
    const validation = validateObjectStorageIntent(intent);
    if (!validation.valid) {
      throw new RoutedObjectStorageError(
        'STORAGE_INTENT_INVALID',
        validation.issues.map((issue) => issue.code).join(','),
      );
    }

    const capabilityKey = storageCapabilityKey(intent.operation);
    const policy = this.#policies.find(
      (candidate) =>
        candidate.tenantId === intent.tenantId
        && candidate.capabilityKey === capabilityKey,
    );
    const route = routeConnector(
      {
        tenantId: intent.tenantId,
        capabilityKey,
        requiredResidencyTags: intent.requiredResidencyTags,
        requiredComplianceTags: intent.requiredComplianceTags,
      },
      this.#connectors,
      policy,
    );
    const connector = route.connector;
    if (connector === null) {
      throw new RoutedObjectStorageError(
        'STORAGE_CONNECTOR_UNAVAILABLE',
        'No compliant storage connector is available: '
          + route.reason + '.',
      );
    }
    if (connector.credentialRef === undefined) {
      throw new RoutedObjectStorageError(
        'STORAGE_CREDENTIAL_REFERENCE_REQUIRED',
        'Storage connectors require a managed credential reference.',
      );
    }

    const adapter = this.#adapters.get(connector.connectorKey);
    if (adapter === undefined) {
      throw new RoutedObjectStorageError(
        'STORAGE_ADAPTER_NOT_REGISTERED',
        'No storage adapter is registered for '
          + connector.connectorKey + '.',
      );
    }

    const observation = await adapter.execute({
      intent,
      connector,
    });
    const observationValidation =
      validateObjectStorageObservation(intent, observation);
    if (!observationValidation.valid) {
      throw new RoutedObjectStorageError(
        'STORAGE_OBSERVATION_INVALID',
        observationValidation.issues
          .map((issue) => issue.code)
          .join(','),
      );
    }
    if (
      observation.connectorKey !== connector.connectorKey
      || observation.providerKey !== connector.providerKey
      || observation.region !== connector.region
    ) {
      throw new RoutedObjectStorageError(
        'STORAGE_CONNECTOR_PROVENANCE_MISMATCH',
        'Storage output provenance must match the selected connector.',
      );
    }
    return observation;
  }
}

export function storageCapabilityKey(
  operation: ObjectStorageOperation,
): string {
  return 'storage.' + operation.toLocaleLowerCase();
}
