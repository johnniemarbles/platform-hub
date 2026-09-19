import {
  CustodyTicketError,
  verifyCustodyTicket,
  type CustodyTicketPrincipal,
} from '@platform-hub/credential-custody';

/**
 * WO-E8-B2 — verify signed custody tickets from the control-plane.
 *
 * Dev scaffold tickets (base64url tenant:subject) remain available only when
 * CUSTODY_ALLOW_DEV_TICKETS=true for local integration without platform-web.
 */

export class CustodyAuthError extends Error {
  readonly code: string;
  constructor(message = 'A valid custody ticket is required.', code = 'CUSTODY_AUTH_REQUIRED') {
    super(message);
    this.name = 'CustodyAuthError';
    this.code = code;
  }
}

export interface CustodyPrincipal {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly stepUpAt?: number;
  readonly expiresAt?: number;
}

function allowDevTickets(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CUSTODY_ALLOW_DEV_TICKETS === 'true' && env.NODE_ENV !== 'production';
}

function tryDevScaffoldTicket(ticket: string): CustodyPrincipal | null {
  try {
    const decoded = Buffer.from(ticket, 'base64url').toString('utf8');
    if (decoded.includes('.')) return null;
    const [tenantId, subjectId] = decoded.split(':');
    if (!tenantId || !subjectId) return null;
    return { tenantId, subjectId };
  } catch {
    return null;
  }
}

export function requireCustodyTicket(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): CustodyPrincipal {
  const ticket = headers.get('x-expadio-custody-ticket')?.trim();
  if (!ticket) throw new CustodyAuthError();

  try {
    const principal: CustodyTicketPrincipal = verifyCustodyTicket({ token: ticket });
    return {
      tenantId: principal.tenantId,
      subjectId: principal.subjectId,
      stepUpAt: principal.stepUpAt,
      expiresAt: principal.expiresAt,
    };
  } catch (error) {
    if (error instanceof CustodyTicketError) {
      if (allowDevTickets(env)) {
        const dev = tryDevScaffoldTicket(ticket);
        if (dev) return dev;
      }
      throw new CustodyAuthError(error.message, error.code);
    }
    throw error;
  }
}

/** @deprecated Prefer signed tickets from POST /api/custody/ticket */
export function encodeDevCustodyTicket(tenantId: string, subjectId: string): string {
  return Buffer.from(`${tenantId}:${subjectId}`, 'utf8').toString('base64url');
}
