import { Module } from '@nestjs/common';
import { DeletedItemsService } from './deleted-items/deleted-items.service.js';
import { OccasionsService } from './occasions/occasions.service.js';
import { PropertiesService } from './properties/properties.service.js';
import { DeletedItemsController, OccasionsController, PropertiesController, TagsController } from './settings.controllers.js';
import { StaffUsersController } from './staff-users/staff-users.controller.js';
import { StaffUsersService } from './staff-users/staff-users.service.js';
import { TagsService } from './tags/tags.service.js';

// Settings → Staff users, Hotels, Occasions, Tags, Deleted items (admin only).
@Module({
  controllers: [StaffUsersController, PropertiesController, OccasionsController, TagsController, DeletedItemsController],
  providers: [StaffUsersService, PropertiesService, OccasionsService, TagsService, DeletedItemsService],
})
export class SettingsModule {}
