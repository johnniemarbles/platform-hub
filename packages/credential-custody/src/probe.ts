/**
 * Design spec §2.4 — the intake probe.
 *
 * PORTED PATTERN: BEMP's validate-before-persist
 * (apps/core/src/communication/services/communication-settings.service.ts
 *  `validate()` + `testConnection()`), moved into the custody service where
 * plaintext already legitimately exists.
 *
 * What is NOT ported: BEMP's AES-256-GCM channel-config encryption and the
 * comms_channel_configs storage model around it. Target architecture §2
 * retires those; KMS/Vault referencing replaces them entirely.
 *
 * The probe returns three things the panel cannot get any other way:
 *   1. valid                 — never persist a credential that never worked once
 *   2. detectedCapabilities  — read the key's real scope instead of asking
 *   3. warnings              — sandbox mode, trial account, over-broad scope.
 *
 * Item 3 is the highest-leverage thing in this file. "Your SES account is in
 * sandbox mode and can only send to verified addresses" at setup time prevents
 * the most common support ticket in email onboarding.
 *
 * Every probe is READ-ONLY. No message is sent. Nothing is billed.
 */

export type ProbeSeverity = 'BLOCKING' | 'WARNING';

export interface ProbeWarning {
  readonly code: string;
  readonly severity: ProbeSeverity;
  /** Plain language, ends with what to do. Rendered verbatim in the panel. */
  readonly message: string;
  readonly actionUrl?: string;
}

export interface ProbeResult {
  readonly valid: boolean;
  readonly providerKey: string;
  readonly detectedCapabilities: readonly string[];
  readonly warnings: readonly ProbeWarning[];
  /** The provider's own error text. Shown to the tenant; never invented. */
  readonly error?: string;
  readonly checkedAt: string;
}

export interface ProbeInput {
  readonly providerKey: string;
  /** Plaintext, in memory, for this call only. Never logged. */
  readonly secret: string;
  /** Non-secret companion fields (account SID, region, domain). */
  readonly parameters: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
}

export interface CredentialProbe {
  readonly providerKey: string;
  probe(input: ProbeInput): Promise<ProbeResult>;
}

const DEFAULT_TIMEOUT_MS = 8_000;

async function call(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

function nowIso(input: ProbeInput): string {
  return input.now?.() ?? new Date().toISOString();
}

/** Twilio — GET /Accounts/{sid}. Returns account status and type. */
export const twilioProbe: CredentialProbe = {
  providerKey: 'twilio',
  async probe(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const sid = input.parameters.accountSid ?? '';
    if (sid === '') {
      return {
        valid: false, providerKey: 'twilio', detectedCapabilities: [], warnings: [],
        error: 'Account SID is required.', checkedAt: nowIso(input),
      };
    }
    const auth = Buffer.from(`${sid}:${input.secret}`).toString('base64');
    const result = await call(fetchImpl, `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!result.ok) {
      const body = result.body as { message?: string } | null;
      return {
        valid: false, providerKey: 'twilio', detectedCapabilities: [], warnings: [],
        error: body?.message ?? result.error ?? `Twilio returned HTTP ${result.status}.`,
        checkedAt: nowIso(input),
      };
    }

    const account = result.body as { type?: string; status?: string } | null;
    const warnings: ProbeWarning[] = [];
    if (account?.type === 'Trial') {
      warnings.push({
        code: 'TWILIO_TRIAL_ACCOUNT',
        severity: 'WARNING',
        message:
          'This is a trial account. It can only message numbers you have verified with Twilio, and it prepends a trial notice to every message. Upgrade before going live.',
        actionUrl: 'https://console.twilio.com/us1/billing/manage-billing/upgrade',
      });
    }
    if (account?.status !== undefined && account.status !== 'active') {
      warnings.push({
        code: 'TWILIO_ACCOUNT_NOT_ACTIVE',
        severity: 'BLOCKING',
        message: `This Twilio account is ${account.status}. Sending will fail until it is active.`,
      });
    }

    return {
      valid: true,
      providerKey: 'twilio',
      detectedCapabilities: ['sms.send', 'whatsapp.send', 'voice.dial'],
      warnings,
      checkedAt: nowIso(input),
    };
  },
};

/** AWS SES — GetAccount. Returns sending-enabled, quota and sandbox status. */
export const sesProbe: CredentialProbe = {
  providerKey: 'ses',
  async probe(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const region = input.parameters.region ?? '';
    const accessKeyId = input.parameters.accessKeyId ?? '';
    if (region === '' || accessKeyId === '') {
      return {
        valid: false, providerKey: 'ses', detectedCapabilities: [], warnings: [],
        error: 'SES region and access key ID are required.', checkedAt: nowIso(input),
      };
    }

    const { sigV4Headers } = await import('./aws-sigv4.ts');
    const host = `email.${region}.amazonaws.com`;
    const headers = await sigV4Headers({
      method: 'GET', host, path: '/v2/email/account', region, service: 'ses',
      accessKeyId, secretAccessKey: input.secret,
      ...(input.parameters.sessionToken !== undefined
        ? { sessionToken: input.parameters.sessionToken }
        : {}),
    });

    const result = await call(fetchImpl, `https://${host}/v2/email/account`, { method: 'GET', headers });
    if (!result.ok) {
      const body = result.body as { message?: string } | null;
      return {
        valid: false, providerKey: 'ses', detectedCapabilities: [], warnings: [],
        error: body?.message ?? result.error ?? `SES returned HTTP ${result.status}.`,
        checkedAt: nowIso(input),
      };
    }

    const account = result.body as {
      ProductionAccessEnabled?: boolean;
      SendingEnabled?: boolean;
      SendQuota?: { Max24HourSend?: number };
    } | null;

    const warnings: ProbeWarning[] = [];
    if (account?.ProductionAccessEnabled === false) {
      warnings.push({
        code: 'SES_SANDBOX_MODE',
        severity: 'WARNING',
        message:
          'This SES account is in sandbox mode. It can only send to addresses you have verified with AWS, and is capped at 200 messages a day. Request production access before going live.',
        actionUrl: `https://console.aws.amazon.com/ses/home?region=${encodeURIComponent(region)}#/account`,
      });
    }
    if (account?.SendingEnabled === false) {
      warnings.push({
        code: 'SES_SENDING_DISABLED',
        severity: 'BLOCKING',
        message: 'Sending is disabled on this SES account. AWS usually disables sending after a reputation event. Check your SES account dashboard.',
      });
    }

    return {
      valid: true,
      providerKey: 'ses',
      detectedCapabilities: ['email.send'],
      warnings,
      checkedAt: nowIso(input),
    };
  },
};

/** SendGrid — GET /v3/scopes. Returns granted permissions. */
export const sendgridProbe: CredentialProbe = {
  providerKey: 'sendgrid',
  async probe(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const result = await call(fetchImpl, 'https://api.sendgrid.com/v3/scopes', {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.secret}` },
    });

    if (!result.ok) {
      const body = result.body as { errors?: { message?: string }[] } | null;
      return {
        valid: false, providerKey: 'sendgrid', detectedCapabilities: [], warnings: [],
        error: body?.errors?.[0]?.message ?? result.error ?? `SendGrid returned HTTP ${result.status}.`,
        checkedAt: nowIso(input),
      };
    }

    const scopes = (result.body as { scopes?: string[] } | null)?.scopes ?? [];
    const warnings: ProbeWarning[] = [];
    if (scopes.includes('admin') || scopes.includes('user.account.read')) {
      warnings.push({
        code: 'SENDGRID_SCOPE_TOO_BROAD',
        severity: 'WARNING',
        message:
          'This key has full-access scope. EXPADIO only needs mail.send. A narrower key limits what an incident could reach — consider replacing it.',
      });
    }
    if (!scopes.includes('mail.send')) {
      warnings.push({
        code: 'SENDGRID_MISSING_MAIL_SEND',
        severity: 'BLOCKING',
        message: 'This key does not grant mail.send, so it cannot deliver messages. Create a key with mail.send permission.',
      });
    }

    return {
      valid: true,
      providerKey: 'sendgrid',
      detectedCapabilities: scopes.includes('mail.send') ? ['email.send'] : [],
      warnings,
      checkedAt: nowIso(input),
    };
  },
};

/** Resend — GET /domains. */
export const resendProbe: CredentialProbe = {
  providerKey: 'resend',
  async probe(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const result = await call(fetchImpl, 'https://api.resend.com/domains', {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.secret}` },
    });

    if (!result.ok) {
      const body = result.body as { message?: string } | null;
      return {
        valid: false, providerKey: 'resend', detectedCapabilities: [], warnings: [],
        error: body?.message ?? result.error ?? `Resend returned HTTP ${result.status}.`,
        checkedAt: nowIso(input),
      };
    }

    const domains = (result.body as { data?: { status?: string }[] } | null)?.data ?? [];
    const warnings: ProbeWarning[] = [];
    if (domains.length === 0) {
      warnings.push({
        code: 'RESEND_NO_DOMAIN',
        severity: 'WARNING',
        message: 'This Resend account has no verified sending domain yet. You will need one before any message can leave.',
      });
    }

    return {
      valid: true,
      providerKey: 'resend',
      detectedCapabilities: ['email.send'],
      warnings,
      checkedAt: nowIso(input),
    };
  },
};

/** Postmark — GET /server. */
export const postmarkProbe: CredentialProbe = {
  providerKey: 'postmark',
  async probe(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const result = await call(fetchImpl, 'https://api.postmarkapp.com/server', {
      method: 'GET',
      headers: { 'X-Postmark-Server-Token': input.secret, Accept: 'application/json' },
    });

    if (!result.ok) {
      const body = result.body as { Message?: string } | null;
      return {
        valid: false, providerKey: 'postmark', detectedCapabilities: [], warnings: [],
        error: body?.Message ?? result.error ?? `Postmark returned HTTP ${result.status}.`,
        checkedAt: nowIso(input),
      };
    }

    const server = result.body as { DeliveryType?: string } | null;
    const warnings: ProbeWarning[] = [];
    if (server?.DeliveryType === 'Sandbox') {
      warnings.push({
        code: 'POSTMARK_SANDBOX',
        severity: 'WARNING',
        message: 'This Postmark server is in sandbox mode. Messages are accepted but never delivered. Switch to a live server before going live.',
      });
    }

    return {
      valid: true,
      providerKey: 'postmark',
      detectedCapabilities: ['email.send'],
      warnings,
      checkedAt: nowIso(input),
    };
  },
};

/** Mailgun — GET /v3/domains. */
export const mailgunProbe: CredentialProbe = {
  providerKey: 'mailgun',
  async probe(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const auth = Buffer.from(`api:${input.secret}`).toString('base64');
    const base = input.parameters.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
    const result = await call(fetchImpl, `https://${base}/v3/domains`, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!result.ok) {
      const body = result.body as { message?: string } | null;
      return {
        valid: false, providerKey: 'mailgun', detectedCapabilities: [], warnings: [],
        error: body?.message ?? result.error ?? `Mailgun returned HTTP ${result.status}.`,
        checkedAt: nowIso(input),
      };
    }

    return {
      valid: true,
      providerKey: 'mailgun',
      detectedCapabilities: ['email.send'],
      warnings: [],
      checkedAt: nowIso(input),
    };
  },
};

/** Vonage — GET /account/get-balance. */
export const vonageProbe: CredentialProbe = {
  providerKey: 'vonage',
  async probe(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const apiKey = input.parameters.apiKey ?? '';
    const url = `https://rest.nexmo.com/account/get-balance?api_key=${encodeURIComponent(apiKey)}&api_secret=${encodeURIComponent(input.secret)}`;
    const result = await call(fetchImpl, url, { method: 'GET' });

    if (!result.ok) {
      return {
        valid: false, providerKey: 'vonage', detectedCapabilities: [], warnings: [],
        error: result.error ?? `Vonage returned HTTP ${result.status}.`,
        checkedAt: nowIso(input),
      };
    }

    const account = result.body as { value?: number } | null;
    const warnings: ProbeWarning[] = [];
    if (typeof account?.value === 'number' && account.value < 1) {
      warnings.push({
        code: 'VONAGE_LOW_BALANCE',
        severity: 'WARNING',
        message: `This Vonage account has a balance of ${account.value}. Sending stops when it reaches zero.`,
      });
    }

    return {
      valid: true,
      providerKey: 'vonage',
      detectedCapabilities: ['sms.send', 'voice.dial'],
      warnings,
      checkedAt: nowIso(input),
    };
  },
};

export const PROBE_REGISTRY: Readonly<Record<string, CredentialProbe>> = {
  twilio: twilioProbe,
  'twilio-sms': twilioProbe,
  'twilio-whatsapp': twilioProbe,
  'twilio-voice': twilioProbe,
  ses: sesProbe,
  sendgrid: sendgridProbe,
  resend: resendProbe,
  postmark: postmarkProbe,
  mailgun: mailgunProbe,
  vonage: vonageProbe,
  'vonage-sms': vonageProbe,
  'vonage-voice': vonageProbe,
};

export function probeFor(providerKey: string): CredentialProbe | null {
  return PROBE_REGISTRY[providerKey] ?? null;
}
