export interface SigV4Options {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export async function sigV4Headers(options: SigV4Options): Promise<Record<string, string>> {
  // Stub implementation until the actual crypto/sigv4 logic is provided
  return {
    Authorization: 'AWS4-HMAC-SHA256 Credential=...',
    'X-Amz-Date': '20260827T000000Z',
  };
}
