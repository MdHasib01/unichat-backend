import { Platform, Prisma, TemplateCategory } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';

export interface TemplateInput {
  name: string;
  category?: TemplateCategory;
  body: string;
  platforms?: Platform[];
  isActive?: boolean;
}

/** Variables are derived from the body so the UI can show them automatically. */
export function extractVariables(body: string): string[] {
  const matches = body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g);
  return Array.from(new Set(Array.from(matches, (m) => m[1])));
}

export async function listTemplates(
  organizationId: string,
  params: { category?: TemplateCategory; search?: string } = {},
) {
  const where: Prisma.MessageTemplateWhereInput = { organizationId };
  if (params.category) where.category = params.category;
  if (params.search) {
    where.OR = [
      { name: { contains: params.search, mode: 'insensitive' } },
      { body: { contains: params.search, mode: 'insensitive' } },
    ];
  }

  return prisma.messageTemplate.findMany({ where, orderBy: { updatedAt: 'desc' } });
}

export async function getTemplate(organizationId: string, templateId: string) {
  const template = await prisma.messageTemplate.findFirst({
    where: { id: templateId, organizationId },
  });
  if (!template) throw new NotFoundError('Template');
  return template;
}

export async function createTemplate(organizationId: string, input: TemplateInput) {
  return prisma.messageTemplate.create({
    data: {
      organizationId,
      name: input.name,
      category: input.category ?? TemplateCategory.OTHER,
      body: input.body,
      variables: extractVariables(input.body),
      platforms: input.platforms ?? [],
      isActive: input.isActive ?? true,
    },
  });
}

export async function updateTemplate(
  organizationId: string,
  templateId: string,
  input: Partial<TemplateInput>,
) {
  const result = await prisma.messageTemplate.updateMany({
    where: { id: templateId, organizationId },
    data: {
      ...input,
      ...(input.body ? { variables: extractVariables(input.body) } : {}),
    },
  });
  if (result.count === 0) throw new NotFoundError('Template');
  return getTemplate(organizationId, templateId);
}

export async function deleteTemplate(organizationId: string, templateId: string) {
  const result = await prisma.messageTemplate.deleteMany({
    where: { id: templateId, organizationId },
  });
  if (result.count === 0) throw new NotFoundError('Template');
}

// --- tags ------------------------------------------------------------------

export async function listTags(organizationId: string) {
  return prisma.tag.findMany({
    where: { organizationId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { conversations: true, contacts: true } } },
  });
}

export async function createTag(
  organizationId: string,
  input: { name: string; color?: string; description?: string },
) {
  return prisma.tag.create({
    data: { organizationId, name: input.name, color: input.color, description: input.description },
  });
}

export async function updateTag(
  organizationId: string,
  tagId: string,
  input: { name?: string; color?: string; description?: string },
) {
  const result = await prisma.tag.updateMany({ where: { id: tagId, organizationId }, data: input });
  if (result.count === 0) throw new NotFoundError('Tag');
  return prisma.tag.findFirstOrThrow({ where: { id: tagId, organizationId } });
}

export async function deleteTag(organizationId: string, tagId: string) {
  const result = await prisma.tag.deleteMany({ where: { id: tagId, organizationId } });
  if (result.count === 0) throw new NotFoundError('Tag');
}

// --- custom fields ---------------------------------------------------------

export async function listCustomFields(organizationId: string) {
  return prisma.customField.findMany({
    where: { organizationId },
    orderBy: [{ entity: 'asc' }, { order: 'asc' }],
  });
}

export async function createCustomField(
  organizationId: string,
  input: {
    entity?: 'CONTACT' | 'CONVERSATION';
    key: string;
    label: string;
    type?: 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN' | 'SELECT' | 'URL';
    options?: string[];
    isRequired?: boolean;
    order?: number;
  },
) {
  return prisma.customField.create({
    data: {
      organizationId,
      entity: input.entity ?? 'CONTACT',
      key: input.key,
      label: input.label,
      type: input.type ?? 'TEXT',
      options: input.options ?? [],
      isRequired: input.isRequired ?? false,
      order: input.order ?? 0,
    },
  });
}

export async function deleteCustomField(organizationId: string, fieldId: string) {
  const result = await prisma.customField.deleteMany({ where: { id: fieldId, organizationId } });
  if (result.count === 0) throw new NotFoundError('Custom field');
}
