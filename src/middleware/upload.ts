import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { BadRequestError } from '../utils/errors';

/**
 * In-memory single-file uploads. Files are validated before anything touches
 * the disk, and callers decide where (and whether) to persist them.
 */
export function singleFile(field: string, maxBytes: number) {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
  }).single(field);

  return (req: Request, res: Response, next: NextFunction) =>
    handler(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? `The file is too large (max ${Math.round(maxBytes / 1024 / 1024) || 1} MB)`
            : err.message;
        return next(new BadRequestError(message, [], 'UPLOAD_REJECTED'));
      }
      return next(err as Error | undefined);
    });
}

const IMAGE_SIGNATURES: Array<{ ext: string; test: (b: Buffer) => boolean }> = [
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
];

/**
 * Stores a PNG, JPEG or WebP image under UPLOAD_DIR/<folder>. The type comes
 * from the file's magic bytes, never the client's claim — and SVG is refused
 * outright because it can carry script.
 */
export async function saveImage(file: Express.Multer.File | undefined, folder: string): Promise<string> {
  if (!file) throw new BadRequestError('Choose an image to upload', [], 'UPLOAD_MISSING');
  const kind = IMAGE_SIGNATURES.find((sig) => sig.test(file.buffer));
  if (!kind) throw new BadRequestError('Upload a PNG, JPG or WebP image', [], 'UPLOAD_TYPE');

  const dir = path.resolve(process.cwd(), env.UPLOAD_DIR, folder);
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.${kind.ext}`;
  await fs.writeFile(path.join(dir, name), file.buffer);
  return `/uploads/${folder}/${name}`;
}
