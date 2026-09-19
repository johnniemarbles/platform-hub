import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CustodyTicketError,
  issueCustodyTicket,
  verifyCustodyTicket,
} from '../src/custody-ticket.ts';

const SECRET = 'test-custody-ticket-secret-32b';

test('issue and verify round-trip', () => {
  const now = Date.parse('2026-09-19T12:00:00.000Z');
  const { token, payload } = issueCustodyTicket({
    tenantId: '00000000-0000-0000-0000-000000000001',
    subjectId: 'user_abc',
    stepUpAt: now - 5_000,
    nowMs: now,
    secret: SECRET,
    ttlSeconds: 60,
  });
  const principal = verifyCustodyTicket({ token, secret: SECRET, nowMs: now + 1_000 });
  assert.equal(principal.tenantId, payload.tenantId);
  assert.equal(principal.subjectId, payload.subjectId);
});

test('rejects tampered payload', () => {
  const now = Date.now();
  const { token } = issueCustodyTicket({
    tenantId: 't1',
    subjectId: 's1',
    stepUpAt: now,
    nowMs: now,
    secret: SECRET,
  });
  const [payloadB64, sig] = token.split('.');
  const tampered = `${payloadB64.slice(0, -2)}aa.${sig}`;
  assert.throws(
    () => verifyCustodyTicket({ token: tampered, secret: SECRET, nowMs: now }),
    (e: unknown) => e instanceof CustodyTicketError && e.code === 'CUSTODY_TICKET_INVALID_SIGNATURE',
  );
});

test('rejects expired ticket', () => {
  const now = Date.now();
  const { token } = issueCustodyTicket({
    tenantId: 't1',
    subjectId: 's1',
    stepUpAt: now,
    nowMs: now,
    secret: SECRET,
    ttlSeconds: 30,
  });
  assert.throws(
    () => verifyCustodyTicket({ token, secret: SECRET, nowMs: now + 60_000 }),
    (e: unknown) => e instanceof CustodyTicketError && e.code === 'CUSTODY_TICKET_EXPIRED',
  );
});

test('rejects missing secret', () => {
  assert.throws(
    () =>
      issueCustodyTicket({
        tenantId: 't1',
        subjectId: 's1',
        stepUpAt: Date.now(),
        secret: '',
      }),
    (e: unknown) => e instanceof CustodyTicketError && e.code === 'CUSTODY_TICKET_SECRET_MISSING',
  );
});
