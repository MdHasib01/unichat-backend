import { z } from 'zod';

export const idParam = z.object({ id: z.string().min(1) });

export const paginationQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  search: z.string().trim().min(1).max(200).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

export const cuid = z.string().min(1).max(64);

export const optionalText = (max = 2000) => z.string().trim().max(max).optional().nullable();

export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #6366f1');

export const platformEnum = z.enum(['FACEBOOK', 'INSTAGRAM', 'WHATSAPP', 'INTERNAL']);
export const messagingPlatformEnum = z.enum(['FACEBOOK', 'INSTAGRAM', 'WHATSAPP']);
export const conversationStatusEnum = z.enum(['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED']);
export const conversationPriorityEnum = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export const memberRoleEnum = z.enum(['OWNER', 'ADMIN', 'MANAGER', 'AGENT']);
export const aiModeEnum = z.enum(['ENABLED', 'PAUSED', 'DISABLED']);

export const attachmentSchema = z.object({
  type: z.enum(['image', 'video', 'audio', 'file', 'sticker', 'location']),
  url: z.string().url(),
  name: z.string().max(255).optional(),
  mimeType: z.string().max(128).optional(),
  size: z.number().int().nonnegative().optional(),
});

export const businessHoursSchema = z.array(
  z.object({
    day: z.number().int().min(0).max(6),
    open: z.string().regex(/^\d{1,2}:\d{2}$/),
    close: z.string().regex(/^\d{1,2}:\d{2}$/),
    enabled: z.boolean(),
  }),
);
