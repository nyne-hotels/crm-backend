-- Module 5 – the database side of do-not-contact and the marketing email list.

-- ---------- audit trigger for the new table ----------
CREATE TRIGGER t_marketing_exports_audit BEFORE INSERT OR UPDATE ON marketing_exports
  FOR EACH ROW EXECUTE FUNCTION set_audit_columns();--> statement-breakpoint

-- ---------- when and by whom do-not-contact was set ----------
-- Stamped as the status changes to do_not_contact and cleared when it goes
-- back to active, so the app never writes these columns. A value already on
-- the row is kept (a merge can carry over the original date).
CREATE OR REPLACE FUNCTION stamp_do_not_contact() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'do_not_contact' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'do_not_contact' THEN
      NEW.do_not_contact_at := coalesce(NEW.do_not_contact_at, now());
      NEW.do_not_contact_by := coalesce(current_staff_id(), NEW.do_not_contact_by);
    END IF;
  ELSE
    NEW.do_not_contact_at := NULL;
    NEW.do_not_contact_by := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER t_contacts_dnc_stamp BEFORE INSERT OR UPDATE OF status ON contacts
  FOR EACH ROW EXECUTE FUNCTION stamp_do_not_contact();--> statement-breakpoint

-- ---------- do-not-contact switches every channel to opted out ----------
-- Before: only existing consent rows changed, keeping their old source, and it
-- ran again on every save of a do-not-contact guest. Now it runs once, when
-- the status changes; both channels end up opted out with source
-- 'do_not_contact' (a missing row is added), dated now, so the request is the
-- latest choice on file. An opt-in recorded later (a ticked booking box) still
-- counts, but marketing_email_list leaves the guest out until staff clear it.
CREATE OR REPLACE FUNCTION do_not_contact_blocks_marketing() RETURNS trigger AS $$
BEGIN
  UPDATE consents
     SET status = 'opted_out', source = 'do_not_contact', evidence = 'Asked not to be contacted', given_at = now()
   WHERE contact_id = NEW.id AND deleted_at IS NULL;
  INSERT INTO consents (contact_id, channel, status, source, evidence, given_at)
  SELECT NEW.id, ch, 'opted_out', 'do_not_contact', 'Asked not to be contacted', now()
    FROM unnest(ARRAY['email', 'whatsapp']) AS ch
   WHERE NOT EXISTS (SELECT 1 FROM consents k WHERE k.contact_id = NEW.id AND k.channel = ch
                       AND k.deleted_at IS NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER t_contacts_dnc ON contacts;--> statement-breakpoint
CREATE TRIGGER t_contacts_dnc AFTER UPDATE OF status ON contacts
  FOR EACH ROW WHEN (NEW.status = 'do_not_contact' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION do_not_contact_blocks_marketing();--> statement-breakpoint

-- ---------- marketing_email_list: columns for the Email list page and export ----------
-- Who is on the list is unchanged. CREATE OR REPLACE VIEW can only add columns
-- at the end, so the existing ones are repeated in the same order:
--   country_code             – the country filter
--   hotels, last_stay        – from checked-out stays, as in contact_overview
--   last_hotel               – the hotel of the last stay, for the export
CREATE OR REPLACE VIEW marketing_email_list AS
SELECT c.id, c.first_name, c.last_name, m.value AS email, c.market, cn.name AS country, c.lifecycle_stage,
       c.country_code,
       (SELECT string_agg(DISTINCT p.name, ', ') FROM stays s JOIN properties p ON p.id = s.property_id
         WHERE s.contact_id = c.id AND s.deleted_at IS NULL AND s.status = 'checked_out') AS hotels,
       ls.arrival_date AS last_stay,
       lp.name AS last_hotel
FROM contacts c
LEFT JOIN countries cn ON cn.code = c.country_code
JOIN consents k        ON k.contact_id = c.id AND k.channel = 'email' AND k.status = 'opted_in'
                      AND k.deleted_at IS NULL
JOIN contact_methods m ON m.contact_id = c.id AND m.kind = 'email' AND m.is_primary
                      AND NOT m.is_shared AND m.status NOT IN ('bounced','invalid') AND m.deleted_at IS NULL
LEFT JOIN LATERAL (
  SELECT s.property_id, s.arrival_date FROM stays s
   WHERE s.contact_id = c.id AND s.deleted_at IS NULL AND s.status = 'checked_out'
   ORDER BY s.arrival_date DESC NULLS LAST, s.id DESC
   LIMIT 1
) ls ON true
LEFT JOIN properties lp ON lp.id = ls.property_id
WHERE c.status = 'active' AND c.deleted_at IS NULL;
