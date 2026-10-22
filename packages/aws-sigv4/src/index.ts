/**
 * AWS Signature Version 4.
 *
 * Isolated in its own package because three callers need it and none of them
 * should have to depend on each other: the SES credential probe, the content
 * asset store (Railway buckets speak S3), and anything else that has to reach
 * an AWS-compatible API.
 *
 * This is written against the published algorithm rather than delegated to the
 * AWS SDK because the SDK is a large dependency to carry into a Next.js server
 * bundle for what amounts to four HMACs. The cost of hand-rolling it is that a
 * mistake is silent — a wrong signature is a 403, not an exception — so the
 * tests pin the two worked examples AWS publishes, signature string included.
 */

import { createHash, createHmac } from 'node:crypto';

export const ALGORITHM = 'AWS4-HMAC-SHA256';

/** The digest of the empty string. Reused often enough to be worth naming. */
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** What a presigned URL sends instead of a body digest. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface SigV4Options extends SigV4Credentials {
  readonly method: string;
  readonly host: string;
  /** Path only, already in the form the server will see. Query goes in `query`. */
  readonly path: string;
  readonly region: string;
  readonly service: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Headers to sign in addition to host/x-amz-date. Names are case-insensitive. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Request body, for the payload digest. Absent means an empty body. */
  readonly body?: Uint8Array | string;
  /** Overrides the payload digest — pass UNSIGNED_PAYLOAD for streamed uploads. */
  readonly payloadSha256?: string;
  readonly now?: Date;
}

export interface PresignOptions extends SigV4Credentials {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly region: string;
  readonly service: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly expiresInSeconds: number;
  readonly now?: Date;
}

/**
 * RFC 3986 percent-encoding.
 *
 * `encodeURIComponent` leaves `!'()*` alone; AWS expects them encoded, and a
 * single stray one changes the canonical request and therefore the signature.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Canonical path.
 *
 * The two rules are not interchangeable. S3 signs the path exactly as it
 * appears in the request line, so a key that already carries encoded
 * characters must not be encoded again. Every other service encodes each
 * segment a second time. Getting this backwards produces a valid-looking
 * request that the service rejects, so the service decides, never the caller.
 */
function canonicalPath(path: string, service: string): string {
  if (!path.startsWith('/')) throw new Error('SIGV4_PATH_MUST_BE_ABSOLUTE');
  if (service === 's3') return path;
  return path.split('/').map(uriEncode).join('/');
}

function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(query[name] ?? '')}`)
    .join('&');
}

function amzDate(now: Date): { stamp: string; date: string } {
  if (Number.isNaN(now.getTime())) throw new Error('SIGV4_CLOCK_INVALID');
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  return { stamp, date: stamp.slice(0, 8) };
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const dateKey = createHmac('sha256', `AWS4${secretAccessKey}`).update(date).digest();
  const regionKey = createHmac('sha256', dateKey).update(region).digest();
  const serviceKey = createHmac('sha256', regionKey).update(service).digest();
  return createHmac('sha256', serviceKey).update('aws4_request').digest();
}

function assertCredentials(credentials: SigV4Credentials): void {
  if (credentials.accessKeyId.trim() === '') throw new Error('SIGV4_ACCESS_KEY_ID_REQUIRED');
  if (credentials.secretAccessKey.trim() === '') throw new Error('SIGV4_SECRET_ACCESS_KEY_REQUIRED');
}

function sign(input: {
  readonly method: string;
  readonly canonicalPath: string;
  readonly canonicalQuery: string;
  readonly canonicalHeaders: string;
  readonly signedHeaders: string;
  readonly payloadSha256: string;
  readonly stamp: string;
  readonly scope: string;
  readonly secretAccessKey: string;
  readonly date: string;
  readonly region: string;
  readonly service: string;
}): string {
  const canonicalRequest = [
    input.method,
    input.canonicalPath,
    input.canonicalQuery,
    input.canonicalHeaders,
    input.signedHeaders,
    input.payloadSha256,
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    input.stamp,
    input.scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const key = signingKey(input.secretAccessKey, input.date, input.region, input.service);
  return createHmac('sha256', key).update(stringToSign).digest('hex');
}

/**
 * Signs a request with an Authorization header.
 *
 * Returns every header that was signed, including the ones this function
 * derived (`host`, `x-amz-date`, `x-amz-content-sha256`). Send exactly these —
 * adding a signed header afterwards, or dropping one, invalidates the
 * signature.
 */
export async function sigV4Headers(options: SigV4Options): Promise<Record<string, string>> {
  assertCredentials(options);
  const { stamp, date } = amzDate(options.now ?? new Date());
  const method = options.method.toUpperCase();
  const payloadSha256 = options.payloadSha256
    ?? (options.body === undefined ? EMPTY_PAYLOAD_SHA256 : sha256Hex(options.body));

  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name.toLowerCase().trim(), value.trim().replace(/\s+/gu, ' '));
  }
  headers.set('host', options.host);
  headers.set('x-amz-date', stamp);
  headers.set('x-amz-content-sha256', payloadSha256);
  if (options.sessionToken !== undefined && options.sessionToken !== '') {
    headers.set('x-amz-security-token', options.sessionToken);
  }

  const names = [...headers.keys()].sort();
  const canonicalHeaders = `${names.map((name) => `${name}:${headers.get(name)}`).join('\n')}\n`;
  const signedHeaders = names.join(';');
  const scope = `${date}/${options.region}/${options.service}/aws4_request`;

  const signature = sign({
    method,
    canonicalPath: canonicalPath(options.path, options.service),
    canonicalQuery: canonicalQuery(options.query ?? {}),
    canonicalHeaders,
    signedHeaders,
    payloadSha256,
    stamp,
    scope,
    secretAccessKey: options.secretAccessKey,
    date,
    region: options.region,
    service: options.service,
  });

  const sent: Record<string, string> = {};
  for (const name of names) sent[name] = headers.get(name) as string;
  sent['authorization'] =
    `${ALGORITHM} Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return sent;
}

/**
 * Builds a presigned URL — authorization carried in the query string.
 *
 * This is what lets a third party (a scanner, or Meta fetching an image it is
 * about to publish) read one object for a bounded window without ever holding
 * bucket credentials.
 */
export function presignUrl(options: PresignOptions): { url: string; expiresAt: string } {
  assertCredentials(options);
  if (!Number.isInteger(options.expiresInSeconds)
    || options.expiresInSeconds < 1
    || options.expiresInSeconds > 604800) {
    throw new Error('SIGV4_PRESIGN_EXPIRY_INVALID');
  }
  const now = options.now ?? new Date();
  const { stamp, date } = amzDate(now);
  const scope = `${date}/${options.region}/${options.service}/aws4_request`;

  const query: Record<string, string> = {
    ...options.query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${options.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(options.expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  if (options.sessionToken !== undefined && options.sessionToken !== '') {
    query['X-Amz-Security-Token'] = options.sessionToken;
  }

  const signature = sign({
    method: options.method.toUpperCase(),
    canonicalPath: canonicalPath(options.path, options.service),
    canonicalQuery: canonicalQuery(query),
    canonicalHeaders: `host:${options.host}\n`,
    signedHeaders: 'host',
    payloadSha256: UNSIGNED_PAYLOAD,
    stamp,
    scope,
    secretAccessKey: options.secretAccessKey,
    date,
    region: options.region,
    service: options.service,
  });

  const search = `${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
  return {
    url: `https://${options.host}${canonicalPath(options.path, options.service)}?${search}`,
    expiresAt: new Date(now.getTime() + options.expiresInSeconds * 1000).toISOString(),
  };
}

/**
 * Encodes an object key for use in a URL path.
 *
 * Each segment is encoded; the separators are not. A key with a `/` in it is a
 * prefix, not an escape, and must survive as one.
 */
export function encodeObjectKey(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}
