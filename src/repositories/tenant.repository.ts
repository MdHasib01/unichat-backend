import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';

/**
 * Tenant-scoped lookups.
 *
 * Every read/write in the app goes through one of these helpers so that the
 * organizationId is part of the WHERE clause, not an afterthought. A record
 * belonging to another organization is indistinguishable from a missing one
 * (spec section 4) — we never leak its existence through a 403.
 */

type Delegate = {
  findFirst: (args: unknown) => Promise<unknown>;
  count: (args: unknown) => Promise<number>;
};

export async function findScoped<T>(
  delegate: Delegate,
  organizationId: string,
  id: string,
  options: { include?: unknown; select?: unknown } = {},
): Promise<T | null> {
  return delegate.findFirst({
    where: { id, organizationId },
    ...(options.include ? { include: options.include } : {}),
    ...(options.select ? { select: options.select } : {}),
  }) as Promise<T | null>;
}

export async function findScopedOrThrow<T>(
  delegate: Delegate,
  organizationId: string,
  id: string,
  resourceName: string,
  options: { include?: unknown; select?: unknown } = {},
): Promise<T> {
  const record = await findScoped<T>(delegate, organizationId, id, options);
  if (!record) throw new NotFoundError(resourceName);
  return record;
}

export async function assertBelongsToOrg(
  model: keyof typeof prisma,
  organizationId: string,
  id: string,
  resourceName: string,
): Promise<void> {
  const delegate = prisma[model] as unknown as Delegate;
  const count = await delegate.count({ where: { id, organizationId } });
  if (count === 0) throw new NotFoundError(resourceName);
}

/** Verifies that a set of ids all belong to the organization. */
export async function assertAllBelongToOrg(
  model: keyof typeof prisma,
  organizationId: string,
  ids: string[],
  resourceName: string,
): Promise<void> {
  if (!ids.length) return;
  const delegate = prisma[model] as unknown as Delegate;
  const count = await delegate.count({ where: { id: { in: ids }, organizationId } });
  if (count !== new Set(ids).size) throw new NotFoundError(resourceName);
}
