import type { MemberRole } from '@prisma/client';
import type { Permission } from '../config/permissions';

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
    }
  }
}

export {};
