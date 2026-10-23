import type { RouteDefinition, HandlerContext } from '../handler.ts';
import { refusal } from '@platform-hub/contracts';
import { resolveAndSend } from '@platform-hub/communication';
import { executeIdempotent, type IdempotencyStore } from '@platform-hub/enforcement';
import type { IncomingMessage } from 'node:http';

interface SendEmailBody {
  readonly to: string;
  readonly templateKey: string;
  readonly parameters: Record<string, unknown>;
  readonly idempotencyKey: string;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export function communicationsRoutes(
  idempotency?: IdempotencyStore<any>,
  customSender?: typeof resolveAndSend,
): readonly RouteDefinition[] {
  const sendFn = customSender ?? resolveAndSend;

  return [
    {
      method: 'POST',
      path: '/v1/communications/email/send',
      scope: {
        permission: 'communication.email.send',
        credentialClass: 'platform-operational',
      },
      handler: async (ctx: HandlerContext, req) => {
        const body = (await readJson(req)) as unknown as SendEmailBody;
        if (!body.templateKey || !body.idempotencyKey || !body.to) {
          return refusal('REFUSED', ctx.traceId, 'missing field');
        }

        const executeSend = async () => {
          const res = await sendFn(ctx.tx, {
            tenantId: ctx.claims.tenantId,
            appId: ctx.claims.appId,
            to: body.to,
            templateKey: body.templateKey,
            parameters: body.parameters ?? {},
            idempotencyKey: body.idempotencyKey,
            traceId: ctx.traceId,
          });
          if (!res.ok) {
            return refusal(res.code as any, ctx.traceId, res.message);
          }
          return res;
        };

        if (idempotency) {
          const { result, replayed } = await executeIdempotent(
            { tenantId: ctx.claims.tenantId, operation: 'communications.email.send', key: body.idempotencyKey },
            idempotency,
            executeSend,
          );
          return { ...result, replayed };
        }

        return executeSend();
      },
    },
  ];
}
