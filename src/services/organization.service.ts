import { MemberRole, MemberStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { cacheDel } from '../lib/redis';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { permissionsForRole } from '../config/permissions';

export async function slugifyOrganizationName(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace';

  let slug = base;
  let attempt = 1;
  // Slugs are globally unique; collisions get a numeric suffix.
  while (await prisma.organization.findUnique({ where: { slug }, select: { id: true } })) {
    slug = `${base}-${++attempt}`;
  }
  return slug;
}

/**
 * Baseline tenant data every new organization needs to be usable immediately:
 * an AI assistant, a default knowledge base, starter tags and a trial plan.
 */
export async function seedOrganizationDefaults(organizationId: string): Promise<void> {
  await prisma.$transaction([
    prisma.aIAssistant.create({
      data: {
        organizationId,
        systemPrompt:
          'You are the customer support assistant for this business. Answer only from the provided business knowledge. If the knowledge does not cover the question, say so and offer to connect the customer with the team.',
      },
    }),
    prisma.aIKnowledgeBase.create({
      data: { organizationId, name: 'Default knowledge base', isDefault: true },
    }),
    prisma.subscription.create({
      data: {
        organizationId,
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    }),
    prisma.tag.createMany({
      data: [
        { organizationId, name: 'VIP', color: '#f59e0b' },
        { organizationId, name: 'New customer', color: '#10b981' },
        { organizationId, name: 'Support', color: '#6366f1' },
        { organizationId, name: 'Sales', color: '#ec4899' },
        { organizationId, name: 'Follow up', color: '#0ea5e9' },
      ],
      skipDuplicates: true,
    }),
  ]);
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  industry: string | null;
  role: MemberRole;
  onboardingComplete: boolean;
  memberCount: number;
}

export async function listUserOrganizations(userId: string): Promise<OrganizationSummary[]> {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId, status: MemberStatus.ACTIVE },
    orderBy: { createdAt: 'asc' },
    select: {
      role: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          industry: true,
          onboardingComplete: true,
          _count: { select: { members: true } },
        },
      },
    },
  });

  return memberships.map((m) => ({
    id: m.organization.id,
    name: m.organization.name,
    slug: m.organization.slug,
    logoUrl: m.organization.logoUrl,
    industry: m.organization.industry,
    role: m.role,
    onboardingComplete: m.organization.onboardingComplete,
    memberCount: m.organization._count.members,
  }));
}

export async function createOrganization(
  userId: string,
  name: string,
  timezone = 'UTC',
): Promise<OrganizationSummary> {
  const slug = await slugifyOrganizationName(name);

  const organization = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name: name.trim(), slug, timezone } });
    await tx.organizationMember.create({
      data: { organizationId: org.id, userId, role: MemberRole.OWNER, status: MemberStatus.ACTIVE },
    });
    return org;
  });

  await seedOrganizationDefaults(organization.id);

  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    logoUrl: organization.logoUrl,
    industry: organization.industry,
    role: MemberRole.OWNER,
    onboardingComplete: organization.onboardingComplete,
    memberCount: 1,
  };
}

/**
 * Switching writes the new organization onto the server-side session. Because
 * every request reads the organization from the session, switching changes the
 * entire application context at once (spec section 7).
 */
export async function switchOrganization(
  userId: string,
  sessionId: string,
  organizationId: string,
): Promise<OrganizationSummary> {
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: { organization: { select: { id: true, name: true, slug: true, logoUrl: true, industry: true, onboardingComplete: true, _count: { select: { members: true } } } } },
  });

  if (!membership || membership.status !== MemberStatus.ACTIVE) {
    throw new ForbiddenError('You are not a member of that organization', 'NOT_A_MEMBER');
  }

  await prisma.session.update({
    where: { id: sessionId },
    data: { activeOrganizationId: organizationId },
  });

  await cacheDel(`session:${sessionId}`);
  await cacheDel(`tenant:${userId}:*`);

  return {
    id: membership.organization.id,
    name: membership.organization.name,
    slug: membership.organization.slug,
    logoUrl: membership.organization.logoUrl,
    industry: membership.organization.industry,
    role: membership.role,
    onboardingComplete: membership.organization.onboardingComplete,
    memberCount: membership.organization._count.members,
  };
}

export async function getOrganization(organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      subscription: true,
      _count: {
        select: { members: true, contacts: true, conversations: true, socialAccounts: true },
      },
    },
  });
  if (!organization) throw new NotFoundError('Organization');
  return organization;
}

export interface UpdateOrganizationInput {
  name?: string;
  description?: string | null;
  industry?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  timezone?: string;
  currency?: string;
  businessHours?: unknown;
}

export async function updateOrganization(organizationId: string, input: UpdateOrganizationInput) {
  const data: Prisma.OrganizationUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.industry !== undefined) data.industry = input.industry;
  if (input.website !== undefined) data.website = input.website;
  if (input.logoUrl !== undefined) data.logoUrl = input.logoUrl;
  if (input.timezone !== undefined) data.timezone = input.timezone;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.businessHours !== undefined) data.businessHours = input.businessHours as never;

  return prisma.organization.update({ where: { id: organizationId }, data });
}

export interface OnboardingInput extends UpdateOrganizationInput {
  step?: number;
  complete?: boolean;
}

export async function saveOnboarding(organizationId: string, input: OnboardingInput) {
  const { step, complete, ...rest } = input;
  const data: Prisma.OrganizationUpdateInput = {};
  if (rest.name !== undefined) data.name = rest.name;
  if (rest.description !== undefined) data.description = rest.description;
  if (rest.industry !== undefined) data.industry = rest.industry;
  if (rest.website !== undefined) data.website = rest.website;
  if (rest.timezone !== undefined) data.timezone = rest.timezone;
  if (rest.businessHours !== undefined) data.businessHours = rest.businessHours as never;
  if (step !== undefined) data.onboardingStep = step;
  if (complete !== undefined) {
    data.onboardingComplete = complete;
    if (complete) data.onboardingStep = 10;
  }
  return prisma.organization.update({ where: { id: organizationId }, data });
}

export function tenantContextPayload(role: MemberRole) {
  return { role, permissions: permissionsForRole(role) };
}

export async function deleteOrganization(organizationId: string, userId: string) {
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true },
  });
  if (membership?.role !== MemberRole.OWNER) {
    throw new ForbiddenError('Only the owner can delete an organization');
  }
  const owned = await prisma.organizationMember.count({
    where: { userId, role: MemberRole.OWNER },
  });
  if (owned <= 1) {
    throw new ConflictError('You must own at least one organization', 'LAST_ORGANIZATION');
  }
  await prisma.organization.delete({ where: { id: organizationId } });
  await cacheDel(`tenant:${userId}:${organizationId}`);
}
