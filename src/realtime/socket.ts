import type { Server as HttpServer } from 'http';
import { Server as SocketServer, type Socket } from 'socket.io';
import cookie from 'cookie';
import { corsOrigins } from '../config/env';
import { logger } from '../lib/logger';
import { createRedisConnection } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { ACCESS_COOKIE, verifyAccessToken } from '../services/token.service';
import { loadTenantContext } from '../middleware/auth';
import {
  REALTIME_CHANNEL,
  RealtimeEvent,
  conversationRoom,
  orgRoom,
  userRoom,
  type RealtimeEnvelope,
} from './events';

let io: SocketServer | null = null;

interface SocketData {
  userId: string;
  organizationId: string;
  role: string;
}

export function initRealtime(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    path: '/socket.io',
    cors: { origin: corsOrigins, credentials: true },
    serveClient: false,
    transports: ['websocket', 'polling'],
  });

  /**
   * Socket auth mirrors the HTTP pipeline: verify the user, then resolve the
   * organization from the server-side session — never from handshake input.
   */
  io.use(async (socket, next) => {
    try {
      const header = socket.handshake.headers.cookie;
      const cookies = header ? cookie.parse(header) : {};
      const token =
        (socket.handshake.auth?.token as string | undefined) ||
        cookies[ACCESS_COOKIE] ||
        (socket.handshake.headers.authorization?.startsWith('Bearer ')
          ? socket.handshake.headers.authorization.slice(7)
          : undefined);

      if (!token) return next(new Error('UNAUTHORIZED'));

      const payload = verifyAccessToken(token);

      const session = await prisma.session.findUnique({
        where: { id: payload.sid },
        select: { activeOrganizationId: true, revokedAt: true, expiresAt: true },
      });
      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        return next(new Error('SESSION_INVALID'));
      }
      if (!session.activeOrganizationId) return next(new Error('NO_ORGANIZATION'));

      const tenant = await loadTenantContext(payload.sub, session.activeOrganizationId);
      if (!tenant) return next(new Error('NOT_A_MEMBER'));

      (socket.data as SocketData) = {
        userId: payload.sub,
        organizationId: tenant.organizationId,
        role: tenant.role,
      };
      return next();
    } catch (error) {
      logger.debug({ err: error }, 'socket auth rejected');
      return next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const { userId, organizationId } = socket.data as SocketData;

    socket.join(orgRoom(organizationId));
    socket.join(userRoom(organizationId, userId));
    logger.debug({ userId, organizationId }, 'socket connected');

    socket.on('conversation:subscribe', async (conversationId: string) => {
      // Only join the room if the conversation truly belongs to this tenant.
      const owned = await prisma.conversation.count({
        where: { id: conversationId, organizationId },
      });
      if (owned) socket.join(conversationRoom(organizationId, conversationId));
    });

    socket.on('conversation:unsubscribe', (conversationId: string) => {
      socket.leave(conversationRoom(organizationId, conversationId));
    });

    socket.on('conversation:typing', (conversationId: string) => {
      socket
        .to(conversationRoom(organizationId, conversationId))
        .emit(RealtimeEvent.TYPING, { conversationId, userId });
    });

    socket.on('disconnect', () => {
      logger.debug({ userId, organizationId }, 'socket disconnected');
    });
  });

  subscribeToRedisBridge();

  return io;
}

function subscribeToRedisBridge() {
  try {
    const subscriber = createRedisConnection();
    subscriber.on('error', (err) => {
      logger.debug({ err: err.message }, 'redis bridge subscriber connection');
    });

    subscriber.subscribe(REALTIME_CHANNEL, (err) => {
      if (err) logger.debug({ err: err.message }, 'failed to subscribe to realtime channel');
      else logger.info('realtime bridge subscribed');
    });

    subscriber.on('message', (_channel, raw) => {
      if (!io) return;
      try {
        const envelope = JSON.parse(raw) as RealtimeEnvelope;
        const room = envelope.userId
          ? userRoom(envelope.organizationId, envelope.userId)
          : envelope.conversationId
            ? conversationRoom(envelope.organizationId, envelope.conversationId)
            : orgRoom(envelope.organizationId);

        io.to(room).emit(envelope.event, envelope.payload);

        // Conversation-scoped events also refresh the inbox list for the org.
        if (envelope.conversationId && !envelope.userId) {
          io.to(orgRoom(envelope.organizationId)).emit(envelope.event, envelope.payload);
        }
      } catch (error) {
        logger.warn({ err: error }, 'failed to relay realtime event');
      }
    });
  } catch (error) {
    logger.debug({ err: error }, 'failed to initialize realtime bridge');
  }
}

export function getIO(): SocketServer | null {
  return io;
}

export async function closeRealtime(): Promise<void> {
  if (io) {
    await io.close();
    io = null;
  }
}
