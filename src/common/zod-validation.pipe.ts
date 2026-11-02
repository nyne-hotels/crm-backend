import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

// Validates and parses a request body or query with a zod schema:
// `@Body(new ZodValidationPipe(createStaffUserSchema)) body: CreateStaffUser`
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const field = issue.path.join('.');
    throw new BadRequestException({
      statusCode: 400,
      message: field ? `${field}: ${issue.message}` : issue.message,
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
}
