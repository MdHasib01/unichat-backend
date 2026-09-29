import { MessageStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getProvider, resolveCredentials } from '../integrations/registry';
import type { NormalizedAttachment } from '../integrations/types';
import type { SendMessageJob } from '../queues/jobTypes';
import { markMessageFailed, markMessageSent } from './message.service';

export type DeliveryOutcome = 'sent' | 'failed' | 'skipped';

/**
 * Hands one queued message to its channel provider and records the result on
 * the message row — the row is the single source of truth that both the
 * dashboard and the customer-facing channel read.
 *
 * Used by the message-sending worker, and inline when the queue is
 * unreachable. Non-final failures are rethrown so the queue can retry; the
 * final one marks the message FAILED with the provider's reason.
 */
export async function deliverOutbound(
  job: SendMessageJob,
  options: { finalAttempt: boolean },
): Promise<DeliveryOutcome> {
  const { organizationId, messageId, socialAccountId, platform, recipientExternalId } = job;

  const message = await prisma.message.findFirst({
    where: { id: messageId, organizationId },
    select: { id: true, status: true },
  });
  // Never send the same message twice on a retry of an already-sent job.
  if (!message || message.status !== MessageStatus.QUEUED) return 'skipped';

  if (!socialAccountId) {
    await markMessageFailed(organizationId, messageId, 'This conversation has no connected channel to send from');
    return 'failed';
  }

  try {
    const credentials = await resolveCredentials(organizationId, socialAccountId);
    const provider = getProvider(platform);

    const result = await provider.sendMessage(credentials, {
      recipientExternalId,
      messageId,
      text: job.body ?? undefined,
      attachments: job.attachments as NormalizedAttachment[] | undefined,
    });

    await markMessageSent(organizationId, messageId, result.externalMessageId);
    return 'sent';
  } catch (error) {
    if (!options.finalAttempt) throw error;

    const reason = error instanceof Error ? error.message : 'Send failed';
    await markMessageFailed(organizationId, messageId, reason);
    await prisma.socialAccount
      .update({ where: { id: socialAccountId }, data: { lastError: reason.slice(0, 500) } })
      .catch(() => undefined);
    return 'failed';
  }
}
