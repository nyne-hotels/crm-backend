import { Module } from '@nestjs/common';
import { OccasionsService } from './occasions/occasions.service.js';
import { PropertiesService } from './properties/properties.service.js';
import { OccasionsController, PropertiesController, TagsController } from './settings.controllers.js';
import { StaffUsersController } from './staff-users/staff-users.controller.js';
import { StaffUsersService } from './staff-users/staff-users.service.js';
import { TagsService } from './tags/tags.service.js';

// Settings → Staff users, Hotels, Occasions, Tags (admin only).
@Module({
  controllers: [StaffUsersController, PropertiesController, OccasionsController, TagsController],
  providers: [StaffUsersService, PropertiesService, OccasionsService, TagsService],
})
export class SettingsModule {}
