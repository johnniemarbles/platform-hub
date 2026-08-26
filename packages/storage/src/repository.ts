import type {
  ObjectStorageIntent,
  ObjectStorageObservation,
} from './index.ts';

export interface ObjectStorageOperationRecord {
  readonly operationId: string;
  readonly intent: ObjectStorageIntent;
  readonly observation: ObjectStorageObservation;
}

export interface RecordObjectStorageOperationResult {
  readonly recorded: boolean;
  readonly operation: ObjectStorageOperationRecord;
}

export interface ObjectStorageOperationRepository {
  record(
    operation: ObjectStorageOperationRecord,
  ): Promise<RecordObjectStorageOperationResult>;
  findByRequest(input: {
    readonly tenantId: string;
    readonly requestId: string;
  }): Promise<ObjectStorageOperationRecord | undefined>;
}
