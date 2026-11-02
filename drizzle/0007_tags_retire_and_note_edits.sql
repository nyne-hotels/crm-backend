-- Module 4: a retired tag (is_active false) leaves the picker but stays on guests who have it;
-- edited_at marks a note whose text was changed ("edited"). The tag index serves the guest-list
-- tag filter and the guest counts in Settings → Tags.
ALTER TABLE "tags" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "contact_tags_tag_idx" ON "contact_tags" USING btree ("tag_id");