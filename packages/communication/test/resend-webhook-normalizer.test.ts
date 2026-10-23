import { test } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { ResendWebhookNormalizer } from '../src/resend-webhook-normalizer.ts';

test('ResendWebhookNormalizer - verifyAndNormalize', async (t) => {
  await t.test('accepts valid svix signature', async () => {
    const normalizer = new ResendWebhookNormalizer({
      resolveSecret: async () => 'whsec_bXlzZWNyZXRrZXk=', // 'mysecretkey' base64 encoded
    });

    const bodyObj = {
      type: 'email.delivered',
      created_at: '2023-01-01T00:00:00Z',
      data: {
        email_id: 'msg_123',
      }
    };
    const rawBody = new TextEncoder().encode(JSON.stringify(bodyObj));

    const svixId = 'msg_id_1';
    const svixTimestamp = '1614556800';
    const signedPayload = `${svixId}.${svixTimestamp}.${JSON.stringify(bodyObj)}`;
    
    // the secret is 'mysecretkey' buffer
    const expectedSig = createHmac('sha256', Buffer.from('mysecretkey', 'utf8'))
      .update(signedPayload)
      .digest('base64');

    const result = await normalizer.verifyAndNormalize({
      connectorKey: 'my-connector',
      headers: {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': `v1,${expectedSig}`,
      },
      rawBody
    });

    assert.strictEqual(result.verified, true);
    if (result.verified) {
      assert.strictEqual(result.events.length, 1);
      assert.strictEqual(result.events[0].state, 'DELIVERED');
      assert.strictEqual(result.events[0].providerMessageId, 'msg_123');
    }
  });

  await t.test('rejects invalid svix signature', async () => {
    const normalizer = new ResendWebhookNormalizer({
      resolveSecret: async () => 'whsec_bXlzZWNyZXRrZXk=',
    });

    const result = await normalizer.verifyAndNormalize({
      connectorKey: 'my-connector',
      headers: {
        'svix-id': '123',
        'svix-timestamp': '123',
        'svix-signature': 'v1,invalid_sig',
      },
      rawBody: new TextEncoder().encode('{}')
    });

    assert.strictEqual(result.verified, false);
    if (!result.verified) {
      assert.strictEqual(result.reasonCode, 'WEBHOOK_SIGNATURE_INVALID');
    }
  });
});
