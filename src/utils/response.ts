import type { Response } from 'express';
import type { ApiErrorDetail } from './errors';

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message: string;
  meta?: Record<string, unknown>;
}

export interface ApiFailure {
  success: false;
  message: string;
  code: string;
  errors: ApiErrorDetail[];
}

export function ok<T>(
  res: Response,
  data: T,
  message = 'Success',
  meta?: Record<string, unknown>,
): Response<ApiSuccess<T>> {
  const body: ApiSuccess<T> = { success: true, data, message };
  if (meta) body.meta = meta;
  return res.status(200).json(body);
}

export function created<T>(res: Response, data: T, message = 'Created'): Response<ApiSuccess<T>> {
  return res.status(201).json({ success: true, data, message });
}

export function noContent(res: Response): Response {
  return res.status(204).send();
}

export function fail(
  res: Response,
  status: number,
  message: string,
  code: string,
  errors: ApiErrorDetail[] = [],
): Response<ApiFailure> {
  return res.status(status).json({ success: false, message, code, errors });
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export function paginationMeta(page: number, pageSize: number, total: number): PaginationMeta {
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return { page, pageSize, total, totalPages, hasMore: page < totalPages };
}

export function paginated<T>(
  res: Response,
  items: T[],
  page: number,
  pageSize: number,
  total: number,
  message = 'Success',
): Response {
  return res.status(200).json({
    success: true,
    data: items,
    message,
    meta: { pagination: paginationMeta(page, pageSize, total) },
  });
}
