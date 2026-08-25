import type { PreparedCommunicationDispatch } from './dispatch.ts';
import type {
  CommunicationProviderSendRequest,
  CommunicationProviderSender,
} from './provider-adapter.ts';
import type {
  CommunicationSenderChannel,
  CommunicationSenderMatchedScope,
  CommunicationSenderPlatformFallback,
  CommunicationSenderRepository,
} from './sender.ts';

export interface PrepareCommunicationProviderSendInput {
  readonly dispatch: PreparedCommunicationDispatch;
  readonly senderRepository: CommunicationSenderRepository;
  readonly platformFallback: CommunicationSenderPlatformFallback;
}

export type PrepareCommunicationProviderSendResult =
  | {
      readonly ok: true;
      readonly senderScope: CommunicationSenderMatchedScope;
      readonly request: CommunicationProviderSendRequest;
    }
  | {
      readonly ok: false;
      readonly reasonCode: 'SENDER_UNVERIFIED';
      readonly senderScope: 'NONE';
    };

/**
 * Provider-neutral preparation boundary. External sender channels require a
 * verified active default sender; in-app and push delivery do not use this
 * sender-identity model and therefore skip sender resolution.
 */
export async function prepareCommunicationProviderSendRequest(
  input: PrepareCommunicationProviderSendInput,
): Promise<PrepareCommunicationProviderSendResult> {
  const channel = input.dispatch.channel;
  let sender: CommunicationProviderSender | undefined;
  let senderScope: CommunicationSenderMatchedScope = 'NONE';

  if (isSenderChannel(channel)) {
    const resolution = await input.senderRepository.resolveVerifiedDefault({
      tenantId: input.dispatch.tenantId,
      ...(input.dispatch.organizationId === undefined
        ? {}
        : { organizationId: input.dispatch.organizationId }),
      channel,
      purpose: input.dispatch.purpose,
      platformFallback: input.platformFallback,
    });

    if (resolution.sender === null || resolution.matchedScope === 'NONE') {
      return {
        ok: false,
        reasonCode: 'SENDER_UNVERIFIED',
        senderScope: 'NONE',
      };
    }

    senderScope = resolution.matchedScope;
    sender = {
      senderKey: resolution.sender.senderId,
      address: resolution.sender.address,
      ...(resolution.sender.displayName === undefined
        ? {}
        : { displayName: resolution.sender.displayName }),
      ...(resolution.sender.replyTo === undefined
        ? {}
        : { replyTo: resolution.sender.replyTo }),
    };
  }

  return {
    ok: true,
    senderScope,
    request: {
      tenantId: input.dispatch.tenantId,
      ...(input.dispatch.organizationId === undefined
        ? {}
        : { organizationId: input.dispatch.organizationId }),
      triggerKey: input.dispatch.triggerKey,
      purpose: input.dispatch.purpose,
      channel,
      recipient: input.dispatch.recipient,
      recipientKey: input.dispatch.recipientKey,
      ...(sender === undefined ? {} : { sender }),
      rendered: input.dispatch.rendered,
      idempotencyKey: input.dispatch.idempotencyKey,
      requestedAt: input.dispatch.requestedAt,
    },
  };
}

function isSenderChannel(channel: PreparedCommunicationDispatch['channel']): channel is CommunicationSenderChannel {
  return channel === 'email'
    || channel === 'sms'
    || channel === 'whatsapp'
    || channel === 'voice'
    || channel === 'rcs';
}
