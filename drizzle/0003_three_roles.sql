-- Roles reduced to admin, management and marketing.
-- Anyone on a removed role (sales, reservations, front_desk, fnb) becomes management.
ALTER TABLE "staff_users" DROP CONSTRAINT "staff_users_role_check";--> statement-breakpoint
UPDATE "staff_users" SET "role" = 'management' WHERE "role" NOT IN ('admin', 'management', 'marketing');--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_role_check" CHECK ("staff_users"."role" IN ('admin', 'management', 'marketing'));
