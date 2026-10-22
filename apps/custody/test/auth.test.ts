import assert from 'node:assert/strict';
import test from 'node:test';
import { issueCustodyTicket } from '@platform-hub/credential-custody';
import {
  CustodyAuthError,
  encodeDevCustodyTicket,
  requireCustodyTicket,
} from '../src/auth.ts';

const SECRET = 'test-custody-ticket-secret-32b';

test('requireCustodyTicket rejects missing ticket', () => {
  assert.throws(
    () => requireCustodyTicket(new Headers(), { CUSTODY_TICKET_SECRET: SECRET }),
    (error: unknown) => error instanceof CustodyAuthError,
  );
});

test('requireCustodyTicket accepts signed HMAC ticket', () => {
  const now = Date.now();
  const { token } = issueCustodyTicket({
    tenantId: '00000000-0000-0000-0000-000000000001',
    subjectId: 'subject-1',
    stepUpAt: now - 1_000,
    nowMs: now,
    secret: SECRET,
  });
  const prev = process.env.CUSTODY_TICKET_SECRET;
  process.env.CUSTODY_TICKET_SECRET = SECRET;
  try {
    const principal = requireCustodyTicket(
      new Headers({ 'x-expadio-custody-ticket': token }),
      { CUSTODY_TICKET_SECRET: SECRET },
    );
    assert.equal(principal.tenantId, '00000000-0000-0000-0000-000000000001');
    assert.equal(principal.subjectId, 'subject-1');
  } finally {
    if (prev === undefined) delete process.env.CUSTODY_TICKET_SECRET;
    else process.env.CUSTODY_TICKET_SECRET = prev;
  }
});

test('dev scaffold ticket only when CUSTODY_ALLOW_DEV_TICKETS=true', () => {
  const ticket = encodeDevCustodyTicket('t-dev', 's-dev');
  assert.throws(
    () =>
      requireCustodyTicket(new Headers({ 'x-expadio-custody-ticket': ticket }), {
        CUSTODY_TICKET_SECRET: SECRET,
        NODE_ENV: 'development',
      }),
    (error: unknown) => error instanceof CustodyAuthError,
  );
  const principal = requireCustodyTicket(
    new Headers({ 'x-expadio-custody-ticket': ticket }),
    {
      CUSTODY_TICKET_SECRET: SECRET,
      CUSTODY_ALLOW_DEV_TICKETS: 'true',
      NODE_ENV: 'development',
    },
  );
  assert.equal(principal.tenantId, 't-dev');
  assert.equal(principal.subjectId, 's-dev');
});
