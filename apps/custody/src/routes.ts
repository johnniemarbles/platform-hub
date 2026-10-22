import { isGenerateLlmProvider } from '@platform-hub/ai-gateway';
import {
  CredentialIntakeService,
  CustodyError,
  parseFingerprintKey,
  WrappingKeyStore,
  type WrappedSecretEnvelope,
} from '@platform-hub/credential-custody';
import { CustodyAuthError, requireCustodyTicket } from './auth.ts';
import type { SecretVault } from '@platform-hub/credential-custody';

const COMMS_PROVIDERS = new Set([
  'openai', 'anthropic', 'google-ai', 'gemini',
  'cloudflare',
  'ses', 'sendgrid', 'resend', 'postmark', 'mailgun',
  'twilio', 'twilio-sms', 'twilio-whatsapp', 'twilio-voice',
  'vonage', 'vonage-sms', 'vonage-voice',
]);

const ALLOWED_PARAMETERS = new Set([
  'accountSid', 'region', 'apiKey', 'accessKeyId', 'domain', 'sessionToken',
  'fromAddress', 'fromNumber', 'messagingServiceSid',
]);

function isEnvelope(value: unknown): value is WrappedSecretEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.kid === 'string'
    && typeof candidate.epk === 'string'
    && typeof candidate.iv === 'string'
    && typeof candidate.ct === 'string'
    && typeof candidate.tag === 'string'
  );
}

function isSupportedIntakeProvider(providerKey: string): boolean {
  return COMMS_PROVIDERS.has(providerKey) || isGenerateLlmProvider(providerKey);
}

export interface CustodyRouteDeps {
  readonly wrappingKeys: WrappingKeyStore;
  readonly vault: SecretVault;
  readonly fingerprintKey: Buffer;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export async function handleHealth(): Promise<Response> {
  return json({ ok: true, service: 'custody-service' });
}

export async function handleWrappingKey(
  request: Request,
  deps: CustodyRouteDeps,
): Promise<Response> {
  try {
    requireCustodyTicket(request.headers);
    deps.wrappingKeys.evictExpired();
    const key = deps.wrappingKeys.issue();
    return json(key, 200, {
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      pragma: 'no-cache',
    });
  } catch (error) {
    return mapError(error);
  }
}

export async function handleCredentials(
  request: Request,
  deps: CustodyRouteDeps,
): Promise<Response> {
  try {
    const principal = requireCustodyTicket(request.headers);
    const body = (await request.json()) as Record<string, unknown>;
    const providerKey = typeof body.providerKey === 'string' ? body.providerKey.trim().toLowerCase() : '';
    const connectorKey = typeof body.connectorKey === 'string' ? body.connectorKey.trim() : '';

    if (!isSupportedIntakeProvider(providerKey)) {
      return json(
        { error: `We do not have an intake probe for '${providerKey}'. Pick a supported provider.` },
        400,
      );
    }
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(connectorKey)) {
      return json(
        { error: 'connectorKey must be 1-128 characters of letters, digits, dot, underscore or hyphen.' },
        400,
      );
    }
    if (!isEnvelope(body.envelope)) {
      return json(
        { error: 'The credential envelope is missing or malformed. Reload the form and try again.' },
        400,
      );
    }

    const parameters: Record<string, string> = {};
    if (typeof body.parameters === 'object' && body.parameters !== null) {
      for (const [key, value] of Object.entries(body.parameters as Record<string, unknown>)) {
        if (ALLOWED_PARAMETERS.has(key) && typeof value === 'string') {
          parameters[key] = value.trim();
        }
      }
    }

    const service = new CredentialIntakeService({
      wrappingKeys: deps.wrappingKeys,
      vault: deps.vault,
      fingerprintKey: deps.fingerprintKey,
    });

    const result = await service.intake({
      tenantId: principal.tenantId,
      connectorKey,
      providerKey,
      custodyMode: 'DELEGATED',
      envelope: body.envelope,
      parameters,
      correlationId: crypto.randomUUID(),
    });

    if (result.probeStatus === 'INVALID') {
      return json(
        {
          probeStatus: 'INVALID',
          warnings: result.warnings,
          error: 'That credential did not work. Nothing has been saved.',
        },
        422,
      );
    }

    return json({ ...result, reference: result.credentialRef }, 201);
  } catch (error) {
    return mapError(error);
  }
}

function mapError(error: unknown): Response {
  if (error instanceof CustodyAuthError) {
    return json({ error: error.message, reasonKey: error.code }, 401);
  }
  if (error instanceof CustodyError) {
    const recoverable =
      error.code === 'CUSTODY_WRAPPING_KEY_EXPIRED' || error.code === 'CUSTODY_WRAPPING_KEY_UNKNOWN';
    return json({ error: error.message, reasonKey: error.code }, recoverable ? 409 : 400);
  }
  return json({ error: 'Custody request failed.' }, 500);
}
