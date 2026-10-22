/**
 * What a content asset binary store must do, independent of who stores it.
 *
 * Split out of the provider adapter so the contract does not carry a vendor's
 * name: the platform stores bytes in a Railway bucket, and the only thing the
 * callers know is this interface.
 */

export interface ContentAssetWriteInput {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly assetId: string;
  readonly objectReference: string;
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly expectedByteLength: number;
  readonly expectedSha256: string;
  readonly requiredResidencyTags: readonly string[];
  readonly requiredComplianceTags: readonly string[];
  readonly correlationId: string;
}

export interface ContentAssetWriteResult {
  readonly objectReference: string;
  readonly providerReference: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly storedAt: string;
}

export interface ContentAssetReadGrantInput {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly assetId: string;
  readonly objectReference: string;
  readonly purpose: string;
  readonly requiredResidencyTags: readonly string[];
  readonly requiredComplianceTags: readonly string[];
}

export interface ContentAssetReadGrant {
  readonly url: string;
  readonly expiresAt: string;
  readonly objectReference: string;
}

export interface ContentAssetBinaryStore {
  store(input: ContentAssetWriteInput): Promise<ContentAssetWriteResult>;
  issueReadGrant(input: ContentAssetReadGrantInput): Promise<ContentAssetReadGrant>;
}
