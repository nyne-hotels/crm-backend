-- Module 7 – the person's stage and leads. A person at stage "lead" moves to
-- "enquired" when their first lead is created; guests further along keep their
-- stage. When a booked lead's stay is checked out, the lifecycle trigger moves
-- them on as before. Also attaches the audit trigger to lead_status_changes.

-- ---------- audit trigger for the new table (insert-only) ----------
CREATE TRIGGER t_lead_status_changes_audit BEFORE INSERT ON lead_status_changes
  FOR EACH ROW EXECUTE FUNCTION set_created_columns();--> statement-breakpoint

-- ---------- a new lead: lead -> enquired ----------
-- Only "lead" moves. Agent contacts, influencers and anyone who has booked or
-- stayed keep their stage.
CREATE OR REPLACE FUNCTION enquired_on_lead() RETURNS trigger AS $$
BEGIN
  UPDATE contacts SET lifecycle_stage = 'enquired'
   WHERE id = NEW.contact_id AND lifecycle_stage = 'lead' AND deleted_at IS NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER t_leads_enquired AFTER INSERT ON leads
  FOR EACH ROW WHEN (NEW.deleted_at IS NULL) EXECUTE FUNCTION enquired_on_lead();--> statement-breakpoint

-- ---------- lifecycle: moving back with no stays left ----------
-- Unchanged from 0006, except that a guest with no checked-out stay and no live
-- booking goes back to "enquired" rather than "lead" when they have a lead.
CREATE OR REPLACE FUNCTION set_lifecycle_from_stays(p_contact bigint, p_forward boolean) RETURNS void AS $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM stays
   WHERE contact_id = p_contact AND status = 'checked_out' AND deleted_at IS NULL;
  IF p_forward THEN
    UPDATE contacts c
       SET lifecycle_stage = CASE WHEN n >= 2 THEN 'repeat_guest' ELSE 'stayed' END,
           contact_type    = CASE WHEN c.contact_type = 'lead' THEN 'guest' ELSE c.contact_type END
     WHERE c.id = p_contact AND n > 0
       AND c.lifecycle_stage IN ('lead','enquired','booked','stayed','stayed_hotel_unknown')
       AND c.lifecycle_stage IS DISTINCT FROM (CASE WHEN n >= 2 THEN 'repeat_guest' ELSE 'stayed' END);
  ELSE
    UPDATE contacts c
       SET lifecycle_stage = CASE
             WHEN n >= 2 THEN 'repeat_guest'
             WHEN n = 1 THEN 'stayed'
             WHEN EXISTS (SELECT 1 FROM stays s WHERE s.contact_id = p_contact AND s.deleted_at IS NULL
                            AND s.status IN ('booked','checked_in')) THEN 'booked'
             WHEN EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = p_contact AND l.deleted_at IS NULL) THEN 'enquired'
             ELSE 'lead' END
     WHERE c.id = p_contact AND c.lifecycle_stage IN ('stayed','repeat_guest');
  END IF;
END;
$$ LANGUAGE plpgsql;
