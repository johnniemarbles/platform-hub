import assert from 'node:assert/strict';
import test from 'node:test';
import { suppressionFromProviderWebhook } from '../src/suppression-policy.ts';
import { communicationRecipientKey } from '../src/index.ts';

/**
 * The link that was missing: a bounce was ingested and recorded, and the
 * SUPPRESSION gate was never told, so the next send went to the same dead
 * address. These pin which events close that loop and -- more carefully --
 * which must not.
 */

const bounced = (bounce: unknown, to: unknown = 'Someone@Example.COM') => ({
  providerKey: 'resend',
  eventType: 'email.bounced',
  payload: { data: { to, ...(bounce === undefined ? {} : { bounce }) } },
});

test('a permanent bounce suppresses, keyed the way a send keys it', () => {
  const decision = suppressionFromProviderWebhook(bounced({ type: 'Permanent', subType: 'NoEmail' }));
  assert.equal(decision.suppress, true);
  assert.ok(decision.suppress);
  assert.equal(decision.reason, 'BOUNCE');
  assert.equal(decision.channel, 'email');

  // The same derivation the send path uses. A suppression written under any
  // other shape is a row the gate looks straight past -- worse than no row,
  // because it reads as handled.
  assert.equal(
    decision.recipientKey,
    communicationRecipientKey({ email: 'Someone@Example.COM' }, 'email'),
  );
  assert.equal(decision.recipientKey, 'someone@example.com');
});

test('a transient bounce does not suppress', () => {
  // A full mailbox on a Tuesday must not permanently cut off a real customer.
  for (const type of ['Transient', 'SoftBounce', 'soft']) {
    const decision = suppressionFromProviderWebhook(bounced({ type }));
    assert.equal(decision.suppress, false, `${type} should not suppress`);
  }
});

test('an unclassified bounce does not suppress, and says why', () => {
  for (const bounce of [undefined, {}, { type: 'Undetermined' }]) {
    const decision = suppressionFromProviderWebhook(bounced(bounce));
    assert.equal(decision.suppress, false);
    assert.ok(!decision.suppress && decision.why.length > 0);
  }
  // Chosen in the direction that matters: a wrongly suppressed address is
  // invisible and permanent, while one that should have been suppressed simply
  // bounces again, visibly.
});

test('a complaint suppresses, which is the opposite of what the work order proposed', () => {
  const decision = suppressionFromProviderWebhook({
    providerKey: 'resend',
    eventType: 'email.complained',
    payload: { data: { to: ['angry@example.com'] } },
  });
  assert.equal(decision.suppress, true);
  assert.ok(decision.suppress);
  assert.equal(decision.reason, 'COMPLAINT');
  assert.equal(decision.recipientKey, 'angry@example.com');
});

test('an event with no recipient is reported, never guessed at', () => {
  // Built inline rather than through the helper, whose default `to` would
  // otherwise stand in for the absent case and prove nothing.
  const payloads: Array<Record<string, unknown>> = [
    { data: { bounce: { type: 'Permanent' } } },
    { data: { to: '', bounce: { type: 'Permanent' } } },
    { data: { to: [], bounce: { type: 'Permanent' } } },
    { data: { to: 42, bounce: { type: 'Permanent' } } },
    { data: { to: '   ', bounce: { type: 'Permanent' } } },
    {},
  ];
  for (const payload of payloads) {
    const decision = suppressionFromProviderWebhook({
      providerKey: 'resend', eventType: 'email.bounced', payload,
    });
    assert.equal(decision.suppress, false, `${JSON.stringify(payload)} should not suppress`);
  }
});

test('deliveries and other providers are left alone', () => {
  assert.equal(
    suppressionFromProviderWebhook({
      providerKey: 'resend', eventType: 'email.delivered',
      payload: { data: { to: 'fine@example.com' } },
    }).suppress,
    false,
  );
  assert.equal(
    suppressionFromProviderWebhook({
      providerKey: 'twilio', eventType: 'email.bounced',
      payload: { data: { to: 'x@example.com', bounce: { type: 'Permanent' } } },
    }).suppress,
    false,
  );
});
