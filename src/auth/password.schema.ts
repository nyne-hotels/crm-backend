import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from './auth.js';

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(128, 'Use at most 128 characters');
