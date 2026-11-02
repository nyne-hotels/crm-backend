-- Module 8: following up low ratings. A feedback response records who marked
-- it followed up, when, and the outcome (required once followed up). A logged
-- call or message can point to the feedback it followed up. Views are in 0016.
ALTER TABLE "feedback" ADD COLUMN "followed_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "followed_up_by" bigint;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "follow_up_outcome" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "feedback_id" bigint;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_followed_up_by_staff_users_id_fk" FOREIGN KEY ("followed_up_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_follow_up_idx" ON "feedback" USING btree ("submitted_at" DESC NULLS LAST) WHERE "feedback"."rating" <= 2 AND "feedback"."followed_up_at" IS NULL AND "feedback"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "interactions_feedback_idx" ON "interactions" USING btree ("feedback_id");--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_follow_up_check" CHECK ("feedback"."followed_up_at" IS NULL OR nullif(trim("feedback"."follow_up_outcome"), '') IS NOT NULL);