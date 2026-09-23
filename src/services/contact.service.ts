import { Platform, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';
import { assertAllBelongToOrg } from '../repositories/tenant.repository';

const contactInclude = {
  tags: { include: { tag: true } },
  identifiers: true,
  fieldValues: { include: { field: true } },
  _count: { select: { conversations: true, orders: true } },
} satisfies Prisma.ContactInclude;

export interface ListContactsParams {
  page: number;
  pageSize: number;
  search?: string;
  platform?: Platform;
  tagId?: string;
  sort?: 'recent' | 'name' | 'created';
}

export async function listContacts(organizationId: string, params: ListContactsParams) {
  const where: Prisma.ContactWhereInput = { organizationId };

  if (params.search) {
    where.OR = [
      { displayName: { contains: params.search, mode: 'insensitive' } },
      { email: { contains: params.search, mode: 'insensitive' } },
      { phone: { contains: params.search, mode: 'insensitive' } },
      { firstName: { contains: params.search, mode: 'insensitive' } },
      { lastName: { contains: params.search, mode: 'insensitive' } },
    ];
  }
  if (params.platform) where.identifiers = { some: { platform: params.platform } };
  if (params.tagId) where.tags = { some: { tagId: params.tagId } };

  const orderBy: Prisma.ContactOrderByWithRelationInput =
    params.sort === 'name'
      ? { displayName: 'asc' }
      : params.sort === 'created'
        ? { createdAt: 'desc' }
        : { updatedAt: 'desc' };

  const [items, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      include: contactInclude,
      orderBy,
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
    }),
    prisma.contact.count({ where }),
  ]);

  return { items, total };
}

export async function getContact(organizationId: string, contactId: string) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, organizationId },
    include: {
      ...contactInclude,
      contactNotes: {
        orderBy: { createdAt: 'desc' },
        include: { author: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
      },
      conversations: {
        orderBy: { lastMessageAt: 'desc' },
        take: 20,
        select: {
          id: true,
          platform: true,
          status: true,
          lastMessageAt: true,
          lastMessagePreview: true,
          messageCount: true,
        },
      },
      orders: {
        orderBy: { placedAt: 'desc' },
        take: 10,
        select: { id: true, orderNumber: true, status: true, total: true, currency: true, placedAt: true },
      },
    },
  });
  if (!contact) throw new NotFoundError('Contact');
  return contact;
}

export interface UpsertContactInput {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string;
  email?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
  country?: string | null;
  city?: string | null;
  notes?: string | null;
  isBlocked?: boolean;
}

export async function createContact(organizationId: string, input: UpsertContactInput) {
  const displayName =
    input.displayName?.trim() ||
    [input.firstName, input.lastName].filter(Boolean).join(' ').trim() ||
    input.email ||
    input.phone ||
    'Unnamed contact';

  return prisma.contact.create({
    data: { organizationId, ...input, displayName },
    include: contactInclude,
  });
}

export async function updateContact(
  organizationId: string,
  contactId: string,
  input: UpsertContactInput,
) {
  // Scoped update: a foreign contact id simply matches nothing.
  const result = await prisma.contact.updateMany({
    where: { id: contactId, organizationId },
    data: input,
  });
  if (result.count === 0) throw new NotFoundError('Contact');
  return getContact(organizationId, contactId);
}

export async function deleteContact(organizationId: string, contactId: string) {
  const result = await prisma.contact.deleteMany({ where: { id: contactId, organizationId } });
  if (result.count === 0) throw new NotFoundError('Contact');
}

export async function addContactNote(
  organizationId: string,
  contactId: string,
  authorId: string,
  body: string,
) {
  const exists = await prisma.contact.count({ where: { id: contactId, organizationId } });
  if (!exists) throw new NotFoundError('Contact');

  return prisma.contactNote.create({
    data: { organizationId, contactId, authorId, body },
    include: { author: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
  });
}

export async function setContactTags(organizationId: string, contactId: string, tagIds: string[]) {
  const exists = await prisma.contact.count({ where: { id: contactId, organizationId } });
  if (!exists) throw new NotFoundError('Contact');
  await assertAllBelongToOrg('tag', organizationId, tagIds, 'Tag');

  await prisma.$transaction([
    prisma.contactTag.deleteMany({ where: { contactId, organizationId } }),
    prisma.contactTag.createMany({
      data: tagIds.map((tagId) => ({ organizationId, contactId, tagId })),
      skipDuplicates: true,
    }),
  ]);

  return getContact(organizationId, contactId);
}

/**
 * Resolves the platform identity of an inbound message to a contact, creating
 * one on first contact. Always scoped to the organization that owns the social
 * account the message arrived on.
 */
export async function findOrCreateContactByIdentifier(params: {
  organizationId: string;
  platform: Platform;
  externalId: string;
  socialAccountId?: string;
  displayName?: string;
  avatarUrl?: string;
  phone?: string;
  email?: string;
}) {
  const existing = await prisma.contactIdentifier.findUnique({
    where: {
      organizationId_platform_externalId: {
        organizationId: params.organizationId,
        platform: params.platform,
        externalId: params.externalId,
      },
    },
    include: { contact: true },
  });

  if (existing) {
    // Backfill profile details we learn later from the provider.
    const patch: Prisma.ContactUpdateInput = {};
    if (params.displayName && existing.contact.displayName === 'Unknown customer') {
      patch.displayName = params.displayName;
    }
    if (params.avatarUrl && !existing.contact.avatarUrl) patch.avatarUrl = params.avatarUrl;
    if (params.phone && !existing.contact.phone) patch.phone = params.phone;
    if (Object.keys(patch).length) {
      return prisma.contact.update({ where: { id: existing.contactId }, data: patch });
    }
    return existing.contact;
  }

  return prisma.contact.create({
    data: {
      organizationId: params.organizationId,
      displayName: params.displayName || 'Unknown customer',
      avatarUrl: params.avatarUrl,
      phone: params.phone,
      email: params.email,
      identifiers: {
        create: {
          organizationId: params.organizationId,
          platform: params.platform,
          externalId: params.externalId,
          socialAccountId: params.socialAccountId,
        },
      },
    },
  });
}

export async function setCustomFieldValue(
  organizationId: string,
  contactId: string,
  fieldId: string,
  value: string | null,
) {
  await assertAllBelongToOrg('customField', organizationId, [fieldId], 'Custom field');
  const exists = await prisma.contact.count({ where: { id: contactId, organizationId } });
  if (!exists) throw new NotFoundError('Contact');

  return prisma.customFieldValue.upsert({
    where: { fieldId_contactId: { fieldId, contactId } },
    create: { organizationId, fieldId, contactId, value },
    update: { value },
  });
}
