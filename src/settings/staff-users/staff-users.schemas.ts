import { z } from 'zod';
import { USERNAME_PATTERN } from '../../auth/auth.js';
import { passwordSchema } from '../../auth/password.schema.js';
import { STAFF_ROLES } from '../../db/schema/index.js';

const trimmed = z.string().trim();
const optionalText = trimmed.transform((v) => v || null).nullish();

export const usernameSchema = trimmed
  .min(3, 'Use 3 to 30 characters')
  .max(30, 'Use 3 to 30 characters')
  .regex(USERNAME_PATTERN, 'Use letters and numbers, with dots between them (e.g. nisha.silva)')
  .transform((v) => v.toLowerCase());

const staffFields = {
  firstName: trimmed.min(1, 'Enter a first name'),
  lastName: optionalText,
  username: usernameSchema,
  role: z.enum(STAFF_ROLES),
  propertyId: trimmed.nullish().transform((v) => v || null), // null = all hotels
  email: z
    .union([z.literal(''), z.email('Enter a valid email')])
    .nullish()
    .transform((v) => v || null),
};

export const createStaffUserSchema = z.object({ ...staffFields, temporaryPassword: passwordSchema });
export type CreateStaffUser = z.infer<typeof createStaffUserSchema>;

export const updateStaffUserSchema = z.object(staffFields).partial();
export type UpdateStaffUser = z.infer<typeof updateStaffUserSchema>;

export const resetPasswordSchema = z.object({ temporaryPassword: passwordSchema });

export const listStaffUsersSchema = z.object({
  q: trimmed.optional(),
  role: z.enum(STAFF_ROLES).optional(),
  propertyId: trimmed.optional(), // a hotel id, or 'all' for group-wide staff
});
export type ListStaffUsers = z.infer<typeof listStaffUsersSchema>;
