import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  verifyWebhookSignature, recordAndCheckReplay, InMemoryWebhookReplayStore,
} from '../src/webhook-replay.ts';

const SECRET = 'wh_shhhhh';
const NOW_SEC = 1700_000_000;
const NOW = () => new Date(NOW_SEC * 1000);

const signed = (body: string, ts = NOW_SEC) => ({
  rawBody: body,
  signedTimestamp: ts,
  signature: createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex'),
});

test('a correctly signed, fresh webhook verifies', () => {
  const s = signed('{"id":"evt_1"}');
  const r = verifyWebhookSignature({ ...s, secret: SECRET, now: NOW, traceId: 'tr' });
  assert.equal(r, true);
});

test('a webhook with the wrong signature is refused (plan acceptance: spoofed)', () => {
  const s = signed('{"id":"evt_1"}');
  const r = verifyWebhookSignature({ ...s, signature: 'deadbeef'.repeat(8), secret: SECRET, now: NOW, traceId: 'tr' });
  assert.notEqual(r, true);
  if (r !== true) assert.equal(r.code, 'WEBHOOK_SIGNATURE_INVALID');
});

test('a webhook older than the tolerance window is refused as replay (plan acceptance: replayed)', () => {
  const s = signed('{"id":"evt_1"}', NOW_SEC - 3600);
  const r = verifyWebhookSignature({ ...s, secret: SECRET, now: NOW, traceId: 'tr' });
  if (r !== true) assert.equal(r.code, 'WEBHOOK_REPLAY');
});

test('a delivery id already seen for the endpoint is refused as replay', async () => {
  const store = new InMemoryWebhookReplayStore();
  const key = { endpointId: 'ep_1', deliveryId: 'evt_42' };
  const first = await recordAndCheckReplay(key, store, NOW(), 'tr');
  assert.equal(first, true);
  const second = await recordAndCheckReplay(key, store, NOW(), 'tr');
  if (second !== true) assert.equal(second.code, 'WEBHOOK_REPLAY');
});

test('the same delivery id on a different endpoint is a different event', async () => {
  const store = new InMemoryWebhookReplayStore();
  const a = await recordAndCheckReplay({ endpointId: 'ep_A', deliveryId: 'evt_42' }, store, NOW(), 'tr');
  const b = await recordAndCheckReplay({ endpointId: 'ep_B', deliveryId: 'evt_42' }, store, NOW(), 'tr');
  assert.equal(a, true); assert.equal(b, true);
});
