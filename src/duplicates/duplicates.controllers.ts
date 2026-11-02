import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { RequireAccess } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  listDuplicatesSchema,
  listMergesSchema,
  mergeSchema,
  pairSchema,
  previewSchema,
  type ListDuplicates,
  type ListMerges,
  type Merge,
  type Pair,
  type Preview,
} from './duplicates.schemas.js';
import { DuplicatesService } from './duplicates.service.js';
import { MergeHistoryService } from './merge-history.service.js';

// Guests → Possible duplicates and the merge screen: admin and management
// only (marketing doesn't see merging at all).
@Controller('duplicates')
@RequireAccess('mergeGuests', 'edit')
export class DuplicatesController {
  constructor(private readonly duplicates: DuplicatesService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listDuplicatesSchema)) query: ListDuplicates) {
    return this.duplicates.list(query);
  }

  // ?a=1&b=2 – both profiles side by side
  @Get('compare')
  compare(@Query(new ZodValidationPipe(pairSchema)) query: Pair) {
    return this.duplicates.compare(query);
  }

  // ?keepId=1&removeId=2 – what the merge would do, in plain words
  @Get('preview')
  preview(@Query(new ZodValidationPipe(previewSchema)) query: Preview) {
    return this.duplicates.preview(query);
  }

  @Post('merge')
  @HttpCode(200)
  merge(@Body(new ZodValidationPipe(mergeSchema)) body: Merge) {
    return this.duplicates.merge(body);
  }

  @Post('not-duplicate')
  @HttpCode(204)
  async markNotDuplicate(@Body(new ZodValidationPipe(pairSchema)) body: Pair) {
    await this.duplicates.markNotDuplicate(body);
  }

  // ?a=1&b=2 – the Undo after "Not a duplicate"
  @Delete('not-duplicate')
  @HttpCode(204)
  async unmarkNotDuplicate(@Query(new ZodValidationPipe(pairSchema)) query: Pair) {
    await this.duplicates.unmarkNotDuplicate(query);
  }
}

// Settings → Merge history (admin only).
@Controller('settings/merges')
@RequireAccess('settings', 'edit')
export class MergeHistoryController {
  constructor(private readonly history: MergeHistoryService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listMergesSchema)) query: ListMerges) {
    return this.history.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.history.get(id);
  }
}
