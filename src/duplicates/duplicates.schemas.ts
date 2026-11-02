import { z } from 'zod';
import { DUPLICATE_REASONS } from './merge-rules.js';

const guestId = z.coerce.number().int().positive();

// ---------- Guests → Possible duplicates ----------
export const DUPLICATES_PAGE_SIZE = 50;

export const listDuplicatesSchema = z.object({
  reason: z.enum(DUPLICATE_REASONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(DUPLICATES_PAGE_SIZE),
});
export type ListDuplicates = z.infer<typeof listDuplicatesSchema>;

// Two different guests, in any order.
export const pairSchema = z
  .object({ a: guestId, b: guestId })
  .refine((v) => v.a !== v.b, { path: ['b'], message: 'Choose two different guests' });
export type Pair = z.infer<typeof pairSchema>;

const keepAndRemove = { keepId: guestId, removeId: guestId };
const notTheSame = (v: { keepId: number; removeId: number }) => v.keepId !== v.removeId;
const sameGuest = { path: ['removeId'], message: 'Choose two different guests' };

// What the merge would do, before confirming.
export const previewSchema = z.object(keepAndRemove).refine(notTheSame, sameGuest);
export type Preview = z.infer<typeof previewSchema>;

export const mergeSchema = z
  .object({ ...keepAndRemove, note: z.string().trim().max(500).transform((v) => v || null).nullish() })
  .refine(notTheSame, sameGuest);
export type Merge = z.infer<typeof mergeSchema>;

// ---------- Settings → Merge history ----------
export const listMergesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListMerges = z.infer<typeof listMergesSchema>;
