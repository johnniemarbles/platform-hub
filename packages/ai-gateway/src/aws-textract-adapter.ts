import { createHash, createHmac } from 'node:crypto';
import type { ConnectorDefinition } from '@platform-hub/provider-registry';
import type { AiInvocationIntent, AiProposal, AiProvenance } from './index.ts';
import type { AiProviderAdapter } from './routing.ts';
import type { AiApiTokenProvider } from './gemini-adapter.ts';
import { fetchAiProvider } from './provider-errors.ts';

export interface AwsTextractAdapterOptions {
  readonly apiToken: AiApiTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
  readonly requestTimeoutMs?: number;
}

/**
 * AWS Textract DetectDocumentText over SigV4.
 * Leased secret is JSON:
 * { accessKeyId, secretAccessKey, sessionToken?, region? }
 * or accessKeyId:secretAccessKey:region
 */
export class AwsTextractAdapter implements AiProviderAdapter {
  readonly adapterKey = 'aws-textract-v1';
  readonly #apiToken: AiApiTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #requestTimeoutMs: number;

  constructor(options: AwsTextractAdapterOptions) {
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 90_000;
  }

  async invoke(input: {
    readonly intent: AiInvocationIntent;
    readonly connector: ConnectorDefinition;
  }): Promise<AiProposal> {
    const { intent, connector } = input;
    if (intent.operation !== 'VISION_ANALYZE') {
      throw new Error(`AI_OPERATION_UNSUPPORTED: AwsTextractAdapter only supports VISION_ANALYZE, got ${intent.operation}`);
    }
    const images = parseImages(intent.inputReference);
    const token = await this.#apiToken({
      tenantId: intent.tenantId,
      connectorKey: connector.connectorKey,
      operation: intent.operation,
      purpose: intent.purpose,
      idempotencyKey: intent.idempotencyKey,
      requestedAt: intent.requestedAt,
    });
    if (!token || token.trim() === '') throw new Error('AI_CREDENTIAL_UNAVAILABLE: Leased token is empty');
    const creds = parseAwsCredentials(token);
    const texts: string[] = [];
    for (const image of images.slice(0, 4)) {
      const payload = JSON.stringify({ Document: { Bytes: image.dataBase64 } });
      const signed = signTextract({
        region: creds.region,
        credentials: creds,
        body: payload,
        now: new Date(),
      });
      const response = await fetchAiProvider(
        connector.providerKey,
        this.#fetch,
        signed.url,
        {
          method: 'POST',
          headers: signed.headers,
          body: payload,
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
        },
      );
      const data = (await response.json()) as {
        Blocks?: Array<{ BlockType?: string; Text?: string }>;
        message?: string;
        Message?: string;
      };
      if (data.message || data.Message) {
        throw new Error(`AI_VISION_PROVIDER_ERROR: ${data.message ?? data.Message}`);
      }
      const lines = (data.Blocks ?? [])
        .filter((block) => block.BlockType === 'LINE' && block.Text)
        .map((block) => block.Text ?? '');
      if (lines.length > 0) texts.push(lines.join('\n'));
    }
    const generatedText = texts.join('\n').trim();
    if (generatedText === '') throw new Error('AI_VISION_OUTPUT_INVALID');
    const processedAt = this.#now();
    const provenance: AiProvenance = {
      connectorKey: connector.connectorKey,
      providerKey: connector.providerKey,
      modelKey: 'aws-textract.detect-document-text',
      promptConfigurationKey: intent.promptConfiguration.key,
      promptConfigurationVersion: intent.promptConfiguration.version,
      sourceReferences: [intent.inputReference],
      processedAt,
    };
    return {
      invocationId: intent.invocationId,
      tenantId: intent.tenantId,
      status: 'OBSERVATION',
      outputReference: `ref://ai-vision/${intent.invocationId}`,
      outputContent: { mediaType: 'text/plain', value: generatedText },
      confidence: 0.93,
      provenance,
    };
  }
}

function parseImages(value: string): Array<{ dataBase64: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('AI_VISION_INPUT_INVALID');
  }
  const images = (parsed as { images?: unknown }).images;
  if (!Array.isArray(images) || images.length === 0) throw new Error('AI_VISION_INPUT_INVALID');
  return images.map((entry) => {
    const dataBase64 = (entry as { dataBase64?: unknown }).dataBase64;
    if (typeof dataBase64 !== 'string' || dataBase64.trim() === '') {
      throw new Error('AI_VISION_INPUT_INVALID: Textract requires inline image bytes');
    }
    return { dataBase64: dataBase64.trim() };
  });
}

function parseAwsCredentials(token: string): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
} {
  const trimmed = token.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as {
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string;
      region?: string;
    };
    if (!parsed.accessKeyId || !parsed.secretAccessKey) throw new Error('AI_CREDENTIAL_UNAVAILABLE: Textract secret needs accessKeyId and secretAccessKey');
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      ...(parsed.sessionToken ? { sessionToken: parsed.sessionToken } : {}),
      region: parsed.region?.trim() || 'us-east-1',
    };
  }
  const [accessKeyId, secretAccessKey, region] = trimmed.split(':');
  if (!accessKeyId || !secretAccessKey) throw new Error('AI_CREDENTIAL_UNAVAILABLE: Textract secret format is accessKeyId:secretAccessKey:region');
  return { accessKeyId, secretAccessKey, region: region || 'us-east-1' };
}

function signTextract(input: {
  readonly region: string;
  readonly credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  readonly body: string;
  readonly now: Date;
}): { url: string; headers: Record<string, string> } {
  const service = 'textract';
  const host = `${service}.${input.region}.amazonaws.com`;
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const canonicalHeaders =
    `content-type:application/x-amz-json-1.1\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:Textract.DetectDocumentText\n`;
  const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp), input.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Date': amzDate,
    'X-Amz-Target': 'Textract.DetectDocumentText',
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'User-Agent': 'expadio-ai-gateway/1.0',
  };
  if (input.credentials.sessionToken) headers['X-Amz-Security-Token'] = input.credentials.sessionToken;
  return { url: `https://${host}/`, headers };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}
