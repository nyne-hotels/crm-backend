-- "Added via": how each contact came to be in the CRM (contacts.added_via,
-- see ADDED_VIA in schema/contacts.ts), with the stay import, contact import
-- or campaign it came from. Set by every way of adding a contact from now on.
--
-- Contacts already in the CRM are worked out from the records, in this order:
--   stay_import     – listed as a new guest in a booking import's details
--   contact_import  – has the 'contact' row a contact import writes for a new contact
--   campaign_form   – no staff author, and created in the same transaction
--                     (same created_at) as a campaign lead of theirs
--   master_import   – no staff author, created in the same transaction as the
--                     first contact (the master list loads into an empty CRM)
--   crm             – any other contact a staff member added
--   unknown         – the rest
-- The audit trigger is paused, so this doesn't show as a change made today.
ALTER TABLE "contacts" ADD COLUMN "added_via" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "added_via_booking_import_id" bigint;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "added_via_contact_import_id" bigint;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "added_via_campaign_id" bigint;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_added_via_booking_import_id_booking_imports_id_fk" FOREIGN KEY ("added_via_booking_import_id") REFERENCES "public"."booking_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_added_via_contact_import_id_contact_imports_id_fk" FOREIGN KEY ("added_via_contact_import_id") REFERENCES "public"."contact_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_added_via_campaign_id_campaigns_id_fk" FOREIGN KEY ("added_via_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "contacts" DISABLE TRIGGER "t_contacts_audit";--> statement-breakpoint

UPDATE "contacts" c SET "added_via" = 'stay_import', "added_via_booking_import_id" = g.import_id
  FROM (
    SELECT DISTINCT ON ((n->>'id')::bigint) (n->>'id')::bigint AS contact_id, b.id AS import_id
      FROM "booking_imports" b, jsonb_array_elements(b.details->'newGuests') n
     ORDER BY (n->>'id')::bigint, b.id
  ) g
 WHERE g.contact_id = c.id;--> statement-breakpoint

UPDATE "contacts" c SET "added_via" = 'contact_import', "added_via_contact_import_id" = x.import_id
  FROM (
    SELECT contact_id, min(import_id) AS import_id
      FROM "contact_import_changes" WHERE field = 'contact' GROUP BY contact_id
  ) x
 WHERE x.contact_id = c.id AND c.added_via IS NULL;--> statement-breakpoint

UPDATE "contacts" c SET "added_via" = 'campaign_form', "added_via_campaign_id" = l.campaign_id
  FROM (
    SELECT DISTINCT ON (contact_id) contact_id, campaign_id, created_at
      FROM "leads" WHERE campaign_id IS NOT NULL
     ORDER BY contact_id, id
  ) l
 WHERE l.contact_id = c.id AND l.created_at = c.created_at AND c.created_by IS NULL AND c.added_via IS NULL;--> statement-breakpoint

UPDATE "contacts" c SET "added_via" = 'master_import'
  FROM (SELECT created_at, created_by FROM "contacts" ORDER BY id LIMIT 1) first
 WHERE first.created_by IS NULL AND c.created_by IS NULL AND c.created_at = first.created_at
   AND c.added_via IS NULL;--> statement-breakpoint

UPDATE "contacts" SET "added_via" = CASE WHEN created_by IS NOT NULL THEN 'crm' ELSE 'unknown' END
 WHERE "added_via" IS NULL;--> statement-breakpoint

ALTER TABLE "contacts" ENABLE TRIGGER "t_contacts_audit";--> statement-breakpoint

ALTER TABLE "contacts" ALTER COLUMN "added_via" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "contacts_added_via_idx" ON "contacts" USING btree ("added_via") WHERE "contacts"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_added_via_check" CHECK ("contacts"."added_via" IN ('crm', 'stay_import', 'contact_import', 'master_import', 'campaign_form', 'mailchimp', 'unknown'));--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_added_via_booking_import_check" CHECK (("contacts"."added_via" = 'stay_import') = ("contacts"."added_via_booking_import_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_added_via_contact_import_check" CHECK (("contacts"."added_via" = 'contact_import') = ("contacts"."added_via_contact_import_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_added_via_campaign_check" CHECK (("contacts"."added_via" IN ('campaign_form', 'mailchimp')) = ("contacts"."added_via_campaign_id" IS NOT NULL));
