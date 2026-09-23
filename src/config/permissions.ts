import { MemberRole } from '@prisma/client';

export const PERMISSIONS = {
  CONVERSATIONS_READ: 'conversations.read',
  CONVERSATIONS_REPLY: 'conversations.reply',
  CONVERSATIONS_ASSIGN: 'conversations.assign',
  CONVERSATIONS_RESOLVE: 'conversations.resolve',

  CONTACTS_READ: 'contacts.read',
  CONTACTS_UPDATE: 'contacts.update',

  AUTOMATION_READ: 'automation.read',
  AUTOMATION_CREATE: 'automation.create',
  AUTOMATION_UPDATE: 'automation.update',
  AUTOMATION_DELETE: 'automation.delete',

  AI_READ: 'ai.read',
  AI_MANAGE: 'ai.manage',

  INTEGRATIONS_READ: 'integrations.read',
  INTEGRATIONS_MANAGE: 'integrations.manage',

  TEAM_READ: 'team.read',
  TEAM_MANAGE: 'team.manage',

  ANALYTICS_READ: 'analytics.read',

  SETTINGS_MANAGE: 'settings.manage',
  BILLING_MANAGE: 'billing.manage',

  SALES_READ: 'sales.read',
  SALES_MANAGE: 'sales.manage',

  CALLS_READ: 'calls.read',
  CALLS_MANAGE: 'calls.manage',

  TEMPLATES_READ: 'templates.read',
  TEMPLATES_MANAGE: 'templates.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'conversations.read': 'View conversations and messages',
  'conversations.reply': 'Reply to conversations',
  'conversations.assign': 'Assign conversations to team members',
  'conversations.resolve': 'Resolve or reopen conversations',
  'contacts.read': 'View contacts',
  'contacts.update': 'Create and update contacts',
  'automation.read': 'View automations',
  'automation.create': 'Create automations',
  'automation.update': 'Update automations',
  'automation.delete': 'Delete automations',
  'ai.read': 'View AI assistant configuration and knowledge',
  'ai.manage': 'Configure the AI assistant and knowledge base',
  'integrations.read': 'View connected channels',
  'integrations.manage': 'Connect and disconnect channels',
  'team.read': 'View team members',
  'team.manage': 'Invite, remove and change roles of team members',
  'analytics.read': 'View analytics and insights',
  'settings.manage': 'Manage organization settings',
  'billing.manage': 'Manage subscription and billing',
  'sales.read': 'View orders, products and parcels',
  'sales.manage': 'Create and update orders, products and parcels',
  'calls.read': 'View call records and recordings',
  'calls.manage': 'Manage call records',
  'templates.read': 'View message templates',
  'templates.manage': 'Create and update message templates',
};

const AGENT_PERMISSIONS: Permission[] = [
  PERMISSIONS.CONVERSATIONS_READ,
  PERMISSIONS.CONVERSATIONS_REPLY,
  PERMISSIONS.CONVERSATIONS_RESOLVE,
  PERMISSIONS.CONTACTS_READ,
  PERMISSIONS.CONTACTS_UPDATE,
  PERMISSIONS.AI_READ,
  PERMISSIONS.INTEGRATIONS_READ,
  PERMISSIONS.TEAM_READ,
  PERMISSIONS.SALES_READ,
  PERMISSIONS.CALLS_READ,
  PERMISSIONS.TEMPLATES_READ,
  PERMISSIONS.AUTOMATION_READ,
];

const MANAGER_PERMISSIONS: Permission[] = [
  ...AGENT_PERMISSIONS,
  PERMISSIONS.CONVERSATIONS_ASSIGN,
  PERMISSIONS.AUTOMATION_CREATE,
  PERMISSIONS.AUTOMATION_UPDATE,
  PERMISSIONS.ANALYTICS_READ,
  PERMISSIONS.SALES_MANAGE,
  PERMISSIONS.CALLS_MANAGE,
  PERMISSIONS.TEMPLATES_MANAGE,
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...MANAGER_PERMISSIONS,
  PERMISSIONS.AUTOMATION_DELETE,
  PERMISSIONS.AI_MANAGE,
  PERMISSIONS.INTEGRATIONS_MANAGE,
  PERMISSIONS.TEAM_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE,
];

const OWNER_PERMISSIONS: Permission[] = [...ADMIN_PERMISSIONS, PERMISSIONS.BILLING_MANAGE];

export const ROLE_PERMISSIONS: Record<MemberRole, Permission[]> = {
  OWNER: dedupe(OWNER_PERMISSIONS),
  ADMIN: dedupe(ADMIN_PERMISSIONS),
  MANAGER: dedupe(MANAGER_PERMISSIONS),
  AGENT: dedupe(AGENT_PERMISSIONS),
};

function dedupe(list: Permission[]): Permission[] {
  return Array.from(new Set(list));
}

export function permissionsForRole(role: MemberRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(role: MemberRole, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

export const ROLE_RANK: Record<MemberRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MANAGER: 2,
  AGENT: 1,
};

/** A member may only grant or modify roles at or below their own rank. */
export function canManageRole(actor: MemberRole, target: MemberRole): boolean {
  return ROLE_RANK[actor] >= ROLE_RANK[target];
}

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];
