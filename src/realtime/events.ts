export const REALTIME_CHANNEL = 'unichat:events';

export const RealtimeEvent = {
  MESSAGE_CREATED: 'message:created',
  MESSAGE_UPDATED: 'message:updated',
  CONVERSATION_CREATED: 'conversation:created',
  CONVERSATION_UPDATED: 'conversation:updated',
  CONVERSATION_ASSIGNED: 'conversation:assigned',
  CONTACT_UPDATED: 'contact:updated',
  NOTIFICATION_CREATED: 'notification:created',
  INTEGRATION_UPDATED: 'integration:updated',
  TYPING: 'conversation:typing',
  PRESENCE: 'presence:updated',
} as const;

export type RealtimeEventName = (typeof RealtimeEvent)[keyof typeof RealtimeEvent];

export interface RealtimeEnvelope<T = unknown> {
  /** Events are addressed by organization so no payload can cross tenants. */
  organizationId: string;
  event: RealtimeEventName;
  payload: T;
  /** Optional narrowing: deliver only to sockets watching this conversation. */
  conversationId?: string;
  /** Optional narrowing: deliver only to one user's sockets. */
  userId?: string;
  emittedAt: string;
}

export function orgRoom(organizationId: string): string {
  return `org:${organizationId}`;
}

export function conversationRoom(organizationId: string, conversationId: string): string {
  return `org:${organizationId}:conversation:${conversationId}`;
}

export function userRoom(organizationId: string, userId: string): string {
  return `org:${organizationId}:user:${userId}`;
}
