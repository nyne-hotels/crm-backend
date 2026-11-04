import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import { RequireAccess } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DeletedItemsService, listDeletedSchema, type ListDeleted } from './deleted-items/deleted-items.service.js';
import {
  createOccasionSchema,
  OccasionsService,
  reorderOccasionsSchema,
  updateOccasionSchema,
} from './occasions/occasions.service.js';
import { PropertiesService, updatePropertySchema, type UpdateProperty } from './properties/properties.service.js';
import { createTagSchema, TagsService, updateTagSchema } from './tags/tags.service.js';

@Controller('settings/properties')
@RequireAccess('settings', 'edit')
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  @Get()
  list() {
    return this.properties.list();
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(updatePropertySchema)) body: UpdateProperty) {
    return this.properties.update(id, body);
  }
}

@Controller('settings/occasions')
@RequireAccess('settings', 'edit')
export class OccasionsController {
  constructor(private readonly occasions: OccasionsService) {}

  @Get()
  list() {
    return this.occasions.list();
  }

  @Post()
  create(@Body(new ZodValidationPipe(createOccasionSchema)) body: z.infer<typeof createOccasionSchema>) {
    return this.occasions.create(body);
  }

  // before :id so "order" isn't read as an id
  @Put('order')
  reorder(@Body(new ZodValidationPipe(reorderOccasionsSchema)) body: z.infer<typeof reorderOccasionsSchema>) {
    return this.occasions.reorder(body.ids);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateOccasionSchema)) body: z.infer<typeof updateOccasionSchema>,
  ) {
    return this.occasions.update(id, body);
  }
}

@Controller('settings/tags')
@RequireAccess('settings', 'edit')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  list() {
    return this.tags.list();
  }

  @Post()
  create(@Body(new ZodValidationPipe(createTagSchema)) body: z.infer<typeof createTagSchema>) {
    return this.tags.create(body);
  }

  // rename, or retire / bring back with isActive
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(updateTagSchema)) body: z.infer<typeof updateTagSchema>) {
    return this.tags.update(id, body);
  }
}

// Restoring is POST /guests/:id/restore, /stays/:id/restore or /companies/:id/restore.
@Controller('settings/deleted-items')
@RequireAccess('settings', 'edit')
export class DeletedItemsController {
  constructor(private readonly deleted: DeletedItemsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listDeletedSchema)) query: ListDeleted) {
    return this.deleted.list(query);
  }
}
