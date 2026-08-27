import assert from 'node:assert/strict';
import test from 'node:test';

import { derivePlane, planeCharacteristics, allocatePlaneCapacity } from '../src/plane.ts';
import { evaluateThrottle, evaluateSpendCap } from '../src/throttle.ts';
import {
  DecisionTraceBuilder,
  ENFORCEMENT_GATES,
  gateOrdinal,
  redactRecipient,
  traceExpiry,
} from '../src/decision-trace.ts';
import { buildRevocationAttestation, SEND_PATH_LEASE_TTL_SECONDS } from '../src/credential-revocation.ts';
import { analyseSpfMerge, countSpfLookups, recordNameForRegistrar, requiredDnsRecords } from '../src/dns-records.ts';
import { ProviderUnavailableAdapter } from '../src/provider-unavailable-adapter.ts';

// ── §0.5 / C14 / K7 — plane separation ───────────────────────────────────────

test('K7: plane is derived from purpose and never supplied by a consumer', () => {
  assert.equal(derivePlane('transactional'), 'TRANSACTIONAL');
  assert.equal(derivePlane('marketing'), 'BULK');
  assert.equal(derivePlane('system'), 'TRANSACTIONAL');
});

test('operational traffic runs transactional but still obeys quiet hours and caps', () => {
  const operational = planeCharacteristics('system');
  assert.equal(operational.plane, 'TRANSACTIONAL');
  assert.equal(operational.quietHoursApply, true);
  assert.equal(operational.frequencyCapApply, true);

  const transactional = planeCharacteristics('transactional');
  assert.equal(transactional.quietHoursApply, false);
});

test('B16: the transactional floor is never borrowable by bulk', () => {
  const allocation = allocatePlaneCapacity({ totalPerMinute: 1000, transactionalFloorPct: 30 });
  assert.equal(allocation.floorReserved, 300);
  assert.equal(allocation.bulkPerMinute, 700);
  // Transactional may use the whole connector; bulk may never touch the floor.
  assert.equal(allocation.transactionalPerMinute, 1000);
  assert.equal(allocation.bulkPerMinute + allocation.floorReserved, 1000);
});

test('§2.7: a failing credential halves bulk and leaves transactional intact', () => {
  const degraded = allocatePlaneCapacity({
    totalPerMinute: 1000, transactionalFloorPct: 30, bulkMultiplier: 0.5,
  });
  assert.equal(degraded.bulkPerMinute, 350);
  assert.equal(degraded.transactionalPerMinute, 1000);
});

// ── §3.1 step 13 / G2 — enforcement, not observation ─────────────────────────

test('message 101 against a 100/day quota is refused', () => {
  const under = evaluateThrottle({ minuteCount: 5, dayCount: 100, limits: { maxPerMinute: 60, maxPerDay: 100 } });
  assert.equal(under.allowed, true);

  const over = evaluateThrottle({ minuteCount: 5, dayCount: 101, limits: { maxPerMinute: 60, maxPerDay: 100 } });
  assert.equal(over.allowed, false);
  assert.equal(over.allowed === false && over.reasonCode, 'THROTTLE_EXCEEDED_DAY');
  assert.equal(over.allowed === false && over.limit, 100);
});

test('the per-minute limit is checked before the daily limit', () => {
  const result = evaluateThrottle({ minuteCount: 61, dayCount: 200, limits: { maxPerMinute: 60, maxPerDay: 100 } });
  assert.equal(result.allowed === false && result.reasonCode, 'THROTTLE_EXCEEDED_MINUTE');
});

test('the spend breaker opens before the cap is exceeded, not after', () => {
  const allowed = evaluateSpendCap({ spentMinorUnits: 900, capMinorUnits: 1000, estimatedCostMinorUnits: 50 });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.state, 'WARNING');

  const refused = evaluateSpendCap({ spentMinorUnits: 990, capMinorUnits: 1000, estimatedCostMinorUnits: 50 });
  assert.equal(refused.allowed, false);
  assert.equal(refused.state, 'OPEN');
});

test('no cap configured means nothing to enforce', () => {
  const result = evaluateSpendCap({ spentMinorUnits: 999999, capMinorUnits: null, estimatedCostMinorUnits: 100 });
  assert.equal(result.allowed, true);
});

// ── §7 — the Decision Trace ──────────────────────────────────────────────────

test('the spine has sixteen gates in the specified order', () => {
  assert.equal(ENFORCEMENT_GATES.length, 16);
  assert.equal(gateOrdinal('INTENT_VALIDATION'), 1);
  assert.equal(gateOrdinal('SENDER_DOMAIN'), 10);
  // §3.1: credential lease (12) precedes quota consume (13) deliberately.
  assert.ok(gateOrdinal('CREDENTIAL_LEASE') < gateOrdinal('QUOTA_THROTTLE'));
  assert.equal(gateOrdinal('OUTCOME_CLASSIFICATION'), 16);
});

test('a trace stops where the pipeline stopped and marks the rest NOT_EVALUATED', () => {
  let tick = 0;
  const builder = new DecisionTraceBuilder(() => (tick += 1));

  builder.pass('INTENT_VALIDATION', 'ok');
  builder.pass('PLANE_DERIVATION', 'TRANSACTIONAL');
  builder.fail('SENDER_DOMAIN', 'acme.com PENDING', {
    message: 'Publish the DKIM record.',
    href: '/communications/onboarding?step=domain',
  });
  // Anything recorded after a failure is ignored: the pipeline had stopped.
  builder.pass('CONNECTOR_ROUTING', 'should not appear');

  const trace = builder.build({
    traceId: 't-1', tenantId: 'tenant-1', kind: 'DISPATCH',
    outcome: 'REFUSED', reasonCode: 'DOMAIN_UNVERIFIED', correlationId: 'c-1',
  });

  assert.equal(trace.gates.length, 16);
  assert.equal(trace.stoppedAtGate, 10);

  const routing = trace.gates.find((gate) => gate.gate === 'CONNECTOR_ROUTING');
  assert.equal(routing?.verdict, 'NOT_EVALUATED');
  assert.match(routing?.detail ?? '', /stopped at gate 10/);

  const quota = trace.gates.find((gate) => gate.gate === 'QUOTA_THROTTLE');
  assert.equal(quota?.verdict, 'NOT_EVALUATED');

  const failed = trace.gates.find((gate) => gate.gate === 'SENDER_DOMAIN');
  assert.equal(failed?.verdict, 'FAIL');
  // §7.2: the failing gate carries the remediation and a route to the fix.
  assert.ok(failed?.remediation);
  assert.ok(failed?.remediationHref);
});

test('§4.3: refusals are retained 400 days, successes 30', () => {
  const at = '2026-01-01T00:00:00.000Z';
  assert.equal(traceExpiry('SENT', at).slice(0, 10), '2026-01-31');
  assert.equal(traceExpiry('REFUSED', at).slice(0, 10), '2027-02-05');
});

test('recipient identifiers are redacted by one shared predicate (§3.4)', () => {
  assert.equal(redactRecipient('alice@acme-supply.com'), 'a***@a***.com');
  assert.equal(redactRecipient('+14155550132'), '+1********32');
  assert.equal(redactRecipient('abc'), '***');
});

// ── §2.6 — revocation attestation ────────────────────────────────────────────

test('the attestation bounds exposure from lease history, not from the request', () => {
  const attestation = buildRevocationAttestation({
    tenantId: 'tenant-1', connectorId: 'conn-1', connectorKey: 'twilio-primary',
    revokedAt: '2026-08-26T14:02:11.000Z', revokedBy: 'user-1', correlationId: 'c-1',
    leaseHistory: [
      { leaseReference: 'l-1', issuedAt: '2026-08-26T13:50:00.000Z', expiresAt: '2026-08-26T13:51:00.000Z', outcome: 'ISSUED' },
      { leaseReference: 'l-2', issuedAt: '2026-08-26T14:01:47.000Z', expiresAt: '2026-08-26T14:02:47.000Z', outcome: 'ISSUED' },
      { leaseReference: '',    issuedAt: '2026-08-26T14:02:00.000Z', expiresAt: '2026-08-26T14:03:00.000Z', outcome: 'DENIED' },
    ],
    messagesRerouted: 0, messagesCancelled: 12,
  });

  // DENIED leases are not exposure: nothing was issued.
  assert.equal(attestation.leasesInWindow, 2);
  assert.equal(attestation.lastLeaseExpiredAt, '2026-08-26T14:02:47.000Z');
  assert.equal(attestation.maxExposureSeconds, 36);
  assert.ok(attestation.maxExposureSeconds <= SEND_PATH_LEASE_TTL_SECONDS);
  assert.match(attestation.attestationText, /No credential lease was issued after/);
});

test('with no issued lease the attestation states zero exposure', () => {
  const attestation = buildRevocationAttestation({
    tenantId: 'tenant-1', connectorId: 'conn-1', connectorKey: 'twilio-primary',
    revokedAt: '2026-08-26T14:02:11.000Z', revokedBy: 'user-1', correlationId: 'c-1',
    leaseHistory: [], messagesRerouted: 0, messagesCancelled: 0,
  });
  assert.equal(attestation.maxExposureSeconds, 0);
  assert.equal(attestation.lastLeaseIssuedAt, null);
});

// ── §6.2 — SPF merge, the most damaging mistake on the domain screen ─────────

test('a second SPF record is detected and a merged value offered instead', () => {
  const analysis = analyseSpfMerge({
    existingTxtRecords: ['v=spf1 include:_spf.google.com -all', 'some-other-txt-record'],
    requiredIncludes: ['amazonses.com'],
  });

  assert.equal(analysis.hasExistingSpf, true);
  assert.equal(analysis.wouldBreakAuthentication, true);
  assert.equal(analysis.mergedRecord, 'v=spf1 include:_spf.google.com include:amazonses.com -all');
  // The tenant's strict -all is preserved, not silently softened to ~all.
  assert.match(analysis.mergedRecord, /-all$/);
  assert.match(analysis.warning ?? '', /breaks email authentication/);
});

test('an already-complete SPF record needs no change', () => {
  const analysis = analyseSpfMerge({
    existingTxtRecords: ['v=spf1 include:amazonses.com ~all'],
    requiredIncludes: ['amazonses.com'],
  });
  assert.equal(analysis.wouldBreakAuthentication, false);
  assert.equal(analysis.addedIncludes.length, 0);
});

test('the SPF ten-lookup limit is enforced', () => {
  const record = `v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:h${i}.example.com`).join(' ')} ~all`;
  assert.equal(countSpfLookups(record), 11);
  const analysis = analyseSpfMerge({ existingTxtRecords: [record], requiredIncludes: [] });
  assert.equal(analysis.exceedsLookupLimit, true);
});

test('registrar quirks produce the right name field (§6.2)', () => {
  const records = requiredDnsRecords('acme.com', {
    dkimTarget: 'k1.domainkey.expadio.com',
    spfIncludes: ['amazonses.com'],
    returnPathHost: 'feedback-smtp.us-east-1.amazonses.com',
  });
  const dkim = records.find((record) => record.purpose === 'DKIM')!;

  // Cloudflare appends the domain; GoDaddy strips it. Same silent failure.
  assert.equal(recordNameForRegistrar(dkim, 'acme.com', 'cloudflare').name, 'k1._domainkey');
  assert.equal(recordNameForRegistrar(dkim, 'acme.com', 'godaddy').name, 'k1._domainkey');
  assert.equal(recordNameForRegistrar(dkim, 'acme.com', 'route53').name, 'k1._domainkey.acme.com');

  const spf = records.find((record) => record.purpose === 'SPF')!;
  assert.equal(recordNameForRegistrar(spf, 'acme.com', 'godaddy').name, '@');
});

test('all four authentication records are generated', () => {
  const records = requiredDnsRecords('acme.com', {
    dkimTarget: 'k1.domainkey.expadio.com',
    spfIncludes: ['amazonses.com'],
    returnPathHost: 'feedback-smtp.us-east-1.amazonses.com',
  });
  assert.deepEqual(records.map((r) => r.purpose), ['SPF', 'DKIM', 'DMARC', 'RETURN_PATH']);
  // Every record carries a plain-language explanation for the tenant.
  assert.ok(records.every((record) => record.explanation.length > 20));
});

// ── C9 — silent failure is prohibited ────────────────────────────────────────

test('an unavailable provider refuses loudly rather than throwing or dropping', async () => {
  const adapter = new ProviderUnavailableAdapter({ requestedProviderKey: 'twilio', channel: 'sms' });
  const result = await adapter.send({} as never);

  assert.equal(result.state, 'REFUSED');
  assert.equal(result.reasonCode, 'PROVIDER_UNAVAILABLE');
  assert.ok(result.refusalReason);
});
