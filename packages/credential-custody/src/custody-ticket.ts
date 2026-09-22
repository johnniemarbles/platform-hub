import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WO-E8-B2 — short-lived HMAC custody tickets.
 *
 * Issued by the control-plane after membership + step-up verification.
 * Verified by custody-service using the same shared secret — no database
 * on the custody host.
 *
 * Wire format: base64url(json payload) + '.' + base64url(hmac-sha256)
 */

export class CustodyTicketError extends Error {
  readonly code:
    | 'CUSTODY_TICKET_SECRET_MISSING'
    | 'CUSTODY_TICKET_MALFORMED'
    | 'CUSTODY_TICKET_INVALID_SIGNATURE'
    | 'CUSTODY_TICKET_EXPIRED'
    | 'CUSTODY_TICKET_STEP_UP_STALE';

  constructor(
    code: CustodyTicketError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'CustodyTicketError';
    this.code = code;
  }
}

export interface CustodyTicketPayload {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly iat: number;
  readonly exp: number;
  /** Epoch ms of the step-up confirmation the ticket was issued under. */
  readonly stepUpAt: number;
  readonly v: 1;
}

export interface CustodyTicketPrincipal {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly stepUpAt: number;
}

const DEFAULT_TTL_SECONDS = 120;
const MAX_TTL_SECONDS = 300;

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function resolveSecret(secret?: string | null): Buffer {
  const raw = secret?.trim() || process.env.CUSTODY_TICKET_SECRET?.trim();
  if (!raw || raw.length < 16) {
    throw new CustodyTicketError(
      'CUSTODY_TICKET_SECRET_MISSING',
      'CUSTODY_TICKET_SECRET must be set (min 16 characters) to issue or verify custody tickets.',
    );
  }
  return Buffer.from(raw, 'utf8');
}

function sign(payloadB64: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function safeEqualB64(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function issueCustodyTicket(input: {
  readonly tenantId: string;
  readonly subjectId: string;
  /** Epoch ms from x-expadio-reauth-at (already validated by requireStepUp). */
  readonly stepUpAt: number;
  readonly ttlSeconds?: number;
  readonly nowMs?: number;
  readonly secret?: string | null;
}): { readonly token: string; readonly expiresAt: number; readonly payload: CustodyTicketPayload } {
  const secret = resolveSecret(input.secret);
  const now = input.nowMs ?? Date.now();
  const ttl = Math.min(
    MAX_TTL_SECONDS,
    Math.max(30, Math.floor(input.ttlSeconds ?? DEFAULT_TTL_SECONDS)),
  );
  const payload: CustodyTicketPayload = {
    v: 1,
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    iat: now,
    exp: now + ttl * 1000,
    stepUpAt: input.stepUpAt,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = sign(payloadB64, secret);
  return {
    token: `${payloadB64}.${sig}`,
    expiresAt: payload.exp,
    payload,
  };
}

export function verifyCustodyTicket(input: {
  readonly token: string;
  readonly secret?: string | null;
  readonly nowMs?: number;
  /** Reject tickets whose step-up is older than this (default 5 minutes). */
  readonly maxStepUpAgeSeconds?: number;
}): CustodyTicketPrincipal {
  const secret = resolveSecret(input.secret);
  const token = input.token.trim();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new CustodyTicketError('CUSTODY_TICKET_MALFORMED', 'Custody ticket is malformed.');
  }
  const [payloadB64, sig] = parts;
  const expected = sign(payloadB64, secret);
  if (!safeEqualB64(sig, expected)) {
    throw new CustodyTicketError(
      'CUSTODY_TICKET_INVALID_SIGNATURE',
      'Custody ticket signature is invalid.',
    );
  }

  let payload: CustodyTicketPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as CustodyTicketPayload;
  } catch {
    throw new CustodyTicketError('CUSTODY_TICKET_MALFORMED', 'Custody ticket payload is malformed.');
  }

  if (
    payload.v !== 1
    || typeof payload.tenantId !== 'string'
    || typeof payload.subjectId !== 'string'
    || typeof payload.iat !== 'number'
    || typeof payload.exp !== 'number'
    || typeof payload.stepUpAt !== 'number'
  ) {
    throw new CustodyTicketError('CUSTODY_TICKET_MALFORMED', 'Custody ticket payload is incomplete.');
  }

  const now = input.nowMs ?? Date.now();
  if (now > payload.exp) {
    throw new CustodyTicketError('CUSTODY_TICKET_EXPIRED', 'Custody ticket has expired.');
  }

  const maxStepUpAge = (input.maxStepUpAgeSeconds ?? 300) * 1000;
  if (now - payload.stepUpAt > maxStepUpAge || payload.stepUpAt > now + 30_000) {
    throw new CustodyTicketError(
      'CUSTODY_TICKET_STEP_UP_STALE',
      'Custody ticket step-up confirmation is no longer valid.',
    );
  }

  return {
    tenantId: payload.tenantId,
    subjectId: payload.subjectId,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    stepUpAt: payload.stepUpAt,
  };
}
