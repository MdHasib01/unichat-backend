import type { MemberRole } from '@prisma/client';
import type { Permission } from '../config/permissions';
import type { PublicWidget } from '../services/webchat.service';
import type { VisitorClaims } from '../services/widgetToken.service';

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
}

export interface TenantContext {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  memberId: string;
  role: MemberRole;
  permissions: Permission[];
}

declare global {
  namespace Express {
    interface Request {
      id: string;
      rawBody?: Buffer;
      auth?: AuthContext;
      tenant?: TenantContext;
      /** Public website-chat routes: the widget resolved from its key. */
      widget?: PublicWidget;
      /** Public website-chat routes: the verified visitor. */
      visitor?: VisitorClaims;
    }
  }
}

export {};
