import { z } from 'zod';

/** Strong enough to resist guessing without pushing people to reuse passwords. */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v), {
    message: 'Include an uppercase letter, a lowercase letter and a number',
  });

export const registerSchema = z.object({
  email: z.string().email().max(200),
  password: passwordSchema,
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(''),
  organizationName: z.string().trim().min(2).max(120),
  timezone: z.string().max(80).optional(),
});

export const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email().max(200),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(200),
  password: passwordSchema,
});

export const verifyEmailSchema = z.object({
  token: z.string().min(10).max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
  timezone: z.string().max(80).optional(),
  locale: z.string().max(10).optional(),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(10).max(200),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  password: passwordSchema.optional(),
});
