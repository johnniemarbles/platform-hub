import type {
  ObjectStorageGateway,
  ObjectStorageIntent,
  ObjectStorageObservation,
} from './index.ts';
import type {
  ObjectStorageOperationRecord,
  ObjectStorageOperationRepository,
} from './repository.ts';

export interface AuditedObjectStorageGatewayDependencies {
  readonly gateway: ObjectStorageGateway;
  readonly repository: ObjectStorageOperationRepository;
  readonly operationId: (
    intent: ObjectStorageIntent,
    observation: ObjectStorageObservation,
  ) => string;
}

export class AuditedObjectStorageGateway
implements ObjectStorageGateway {
  private readonly gateway: ObjectStorageGateway;
  private readonly repository: ObjectStorageOperationRepository;
  private readonly operationId:
    AuditedObjectStorageGatewayDependencies['operationId'];

  constructor(dependencies: AuditedObjectStorageGatewayDependencies) {
    this.gateway = dependencies.gateway;
    this.repository = dependencies.repository;
    this.operationId = dependencies.operationId;
  }

  async execute(
    intent: ObjectStorageIntent,
  ): Promise<ObjectStorageObservation> {
    const observation = await this.gateway.execute(intent);
    const operation: ObjectStorageOperationRecord = {
      operationId: this.operationId(intent, observation),
      intent,
      observation,
    };
    if (operation.operationId.trim() === '') {
      throw new Error('STORAGE_OPERATION_ID_REQUIRED');
    }

    await this.repository.record(operation);
    return observation;
  }
}
