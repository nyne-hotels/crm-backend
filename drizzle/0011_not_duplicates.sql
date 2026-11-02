-- Module 6: not_duplicates remembers pairs staff marked "Not a duplicate", so they
-- leave the possible-duplicates queue for good. The view, the audit trigger and the
-- merge_contacts changes are in 0012.
CREATE TABLE "not_duplicates" (
	"contact_a" bigint NOT NULL,
	"contact_b" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" bigint,
	CONSTRAINT "not_duplicates_contact_a_contact_b_pk" PRIMARY KEY("contact_a","contact_b"),
	CONSTRAINT "not_duplicates_order_check" CHECK ("not_duplicates"."contact_a" < "not_duplicates"."contact_b")
);
--> statement-breakpoint
ALTER TABLE "not_duplicates" ADD CONSTRAINT "not_duplicates_contact_a_contacts_id_fk" FOREIGN KEY ("contact_a") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "not_duplicates" ADD CONSTRAINT "not_duplicates_contact_b_contacts_id_fk" FOREIGN KEY ("contact_b") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "not_duplicates" ADD CONSTRAINT "not_duplicates_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "not_duplicates_b_idx" ON "not_duplicates" USING btree ("contact_b");