-- Each campaign's email in Mailchimp, whose report the CRM shows
-- (Campaigns → a campaign). One CRM campaign per Mailchimp email.
ALTER TABLE "campaigns" ADD COLUMN "mailchimp_campaign_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_mailchimp_uq" ON "campaigns" USING btree ("mailchimp_campaign_id") WHERE "campaigns"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_mailchimp_check" CHECK ("campaigns"."mailchimp_campaign_id" ~ '^[a-z0-9]{1,20}$');