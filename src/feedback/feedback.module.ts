import { Module } from '@nestjs/common';
import { EmployeesService } from './employees.service.js';
import {
  EmployeesController,
  FeedbackController,
  FeedbackPanelsController,
  FeedbackUploadsController,
} from './feedback.controllers.js';
import { FeedbackUploadsService } from './feedback-uploads.service.js';
import { FeedbackService } from './feedback.service.js';
import { MentionsService } from './mentions.service.js';

// Guest feedback and employee recognition (Module 8): the inbox, add and
// upload responses, follow-up of low ratings, employee mentions, the
// employee list and pages, hotel ratings, and the Feedback panels on the
// guest profile and the stay. The rules are pure functions in feedback-rules.ts.
// FeedbackUploadsController comes first so /feedback/uploads isn't taken for /feedback/:id.
@Module({
  controllers: [FeedbackUploadsController, FeedbackController, FeedbackPanelsController, EmployeesController],
  providers: [FeedbackService, FeedbackUploadsService, MentionsService, EmployeesService],
})
export class FeedbackModule {}
