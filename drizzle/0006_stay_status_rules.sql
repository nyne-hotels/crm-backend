-- Module 3 – stays have a status (migration 0005), and only checked-out stays
-- count towards "stayed" and "repeat guest". This changes the lifecycle
-- trigger, the stay counts in contact_overview and the stage merge_contacts
-- works out. Also attaches the audit trigger to the two new import tables.

-- ---------- audit trigger for the new tables ----------
CREATE TRIGGER t_booking_imports_audit BEFORE INSERT OR UPDATE ON booking_imports
  FOR EACH ROW EXECUTE FUNCTION set_audit_columns();--> statement-breakpoint
CREATE TRIGGER t_import_mappings_audit BEFORE INSERT OR UPDATE ON import_mappings
  FOR EACH ROW EXECUTE FUNCTION set_audit_columns();--> statement-breakpoint

-- ---------- lifecycle: set a guest's stage from their checked-out stays ----------
-- Forward (a stay was checked out): 1 checked-out stay -> 'stayed', 2+ -> 'repeat_guest',
--   and a 'lead' contact becomes a 'guest'. Never moves anyone backwards.
-- Back (a checked-out stay was cancelled, deleted, un-checked-out or moved to another guest):
--   only guests on 'stayed' or 'repeat_guest' move, to what their remaining checked-out
--   stays say, or – with none left – 'booked' if a booking is still live, else 'lead'.
-- Agent contacts, influencers and 'stayed_hotel_unknown' guests (no stay rows) are never
-- moved back. Booked stays don't change the stage at all until check-out.
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
             ELSE 'lead' END
     WHERE c.id = p_contact AND c.lifecycle_stage IN ('stayed','repeat_guest');
  END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Same name as before, so the list of functions in the database doc still holds.
CREATE OR REPLACE FUNCTION bump_lifecycle_on_stay() RETURNS trigger AS $$
DECLARE
  counted_before boolean := false;
  counted_now    boolean := NEW.status = 'checked_out' AND NEW.deleted_at IS NULL;
  moved          boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    counted_before := OLD.status = 'checked_out' AND OLD.deleted_at IS NULL;
    moved := OLD.contact_id IS DISTINCT FROM NEW.contact_id;
    IF counted_before AND (NOT counted_now OR moved) THEN
      PERFORM set_lifecycle_from_stays(OLD.contact_id, false);
    END IF;
  END IF;
  IF counted_now AND (NOT counted_before OR moved) THEN
    PERFORM set_lifecycle_from_stays(NEW.contact_id, true);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER t_stays_lifecycle ON stays;--> statement-breakpoint
CREATE TRIGGER t_stays_lifecycle AFTER INSERT OR UPDATE OF status, deleted_at, contact_id ON stays
  FOR EACH ROW EXECUTE FUNCTION bump_lifecycle_on_stay();--> statement-breakpoint

-- ---------- contact_overview: hotels, stay count and last stay from checked-out stays ----------
-- Booked, cancelled and no-show stays are not visits yet (or ever). Columns unchanged.
CREATE OR REPLACE VIEW contact_overview AS
SELECT c.id, c.first_name, c.last_name, c.contact_type, c.lifecycle_stage,
       c.market, cn.name AS country, co.name AS company,
       (SELECT value FROM contact_methods m WHERE m.contact_id = c.id AND m.kind = 'email'
           AND m.is_primary AND m.deleted_at IS NULL) AS email,
       (SELECT value FROM contact_methods m WHERE m.contact_id = c.id AND m.kind = 'phone'
           AND m.is_primary AND m.deleted_at IS NULL) AS phone,
       (SELECT string_agg(DISTINCT p.name, ', ') FROM stays s JOIN properties p ON p.id = s.property_id
         WHERE s.contact_id = c.id AND s.deleted_at IS NULL AND s.status = 'checked_out') AS hotels,
       (SELECT count(*) FROM stays s WHERE s.contact_id = c.id AND s.deleted_at IS NULL
           AND s.status = 'checked_out') AS stay_rows,
       (SELECT max(s.arrival_date) FROM stays s WHERE s.contact_id = c.id AND s.deleted_at IS NULL
           AND s.status = 'checked_out') AS last_stay,
       (SELECT status FROM consents k WHERE k.contact_id = c.id AND k.channel = 'email'
           AND k.deleted_at IS NULL) AS email_consent,
       (SELECT string_agg(t.name, ', ') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
         WHERE ct.contact_id = c.id AND t.deleted_at IS NULL) AS tags,
       c.created_at, c.updated_at,
       c.country_code
FROM contacts c
LEFT JOIN companies co ON co.id = c.company_id AND co.deleted_at IS NULL
LEFT JOIN countries cn ON cn.code = c.country_code
WHERE c.deleted_at IS NULL;--> statement-breakpoint

-- ---------- merge_contacts: the merged stage counts checked-out stays only ----------
-- Unchanged from 0001 except for the n_stays count in step 6.
CREATE OR REPLACE FUNCTION merge_contacts(p_keep bigint, p_remove bigint, p_note text DEFAULT NULL)
RETURNS bigint AS $$
DECLARE
  k contacts%ROWTYPE;
  r contacts%ROWTYPE;
  snap jsonb;
  moved jsonb;
  stage_rank text[] := ARRAY['lead','enquired','booked','stayed_hotel_unknown','stayed','repeat_guest'];
  n_stays int;
BEGIN
  IF p_keep = p_remove THEN RAISE EXCEPTION 'Cannot merge a contact into itself'; END IF;
  SELECT * INTO k FROM contacts WHERE id = p_keep   FOR UPDATE;
  SELECT * INTO r FROM contacts WHERE id = p_remove FOR UPDATE;
  IF k.id IS NULL THEN RAISE EXCEPTION 'Contact % to keep does not exist', p_keep; END IF;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Contact % to remove does not exist', p_remove; END IF;

  -- 1. snapshot of the record being removed
  snap := jsonb_build_object(
    'contact',         to_jsonb(r),
    'contact_methods', (SELECT coalesce(jsonb_agg(to_jsonb(m)), '[]') FROM contact_methods m WHERE m.contact_id = p_remove),
    'consents',        (SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]') FROM consents c WHERE c.contact_id = p_remove),
    'tags',            (SELECT coalesce(jsonb_agg(t.name), '[]') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
                         WHERE ct.contact_id = p_remove));
  moved := jsonb_build_object(
    'preferences',    (SELECT coalesce(jsonb_agg(id), '[]') FROM preferences    WHERE contact_id = p_remove),
    'notes',          (SELECT coalesce(jsonb_agg(id), '[]') FROM notes          WHERE contact_id = p_remove),
    'special_dates',  (SELECT coalesce(jsonb_agg(id), '[]') FROM special_dates  WHERE contact_id = p_remove),
    'leads',          (SELECT coalesce(jsonb_agg(id), '[]') FROM leads          WHERE contact_id = p_remove),
    'interactions',   (SELECT coalesce(jsonb_agg(id), '[]') FROM interactions   WHERE contact_id = p_remove),
    'data_issues',    (SELECT coalesce(jsonb_agg(id), '[]') FROM data_issues    WHERE contact_id = p_remove),
    'contact_methods',(SELECT coalesce(jsonb_agg(m.id), '[]') FROM contact_methods m WHERE m.contact_id = p_remove
                         AND NOT EXISTS (SELECT 1 FROM contact_methods x WHERE x.contact_id = p_keep
                                         AND x.kind = m.kind AND x.value = m.value
                                         AND x.deleted_at IS NULL AND m.deleted_at IS NULL)));

  -- 2. move history. A stay both records share (see same_stay) is one visit, so the copy is dropped
  --    instead of turning the person into a "repeat guest".
  snap := snap || jsonb_build_object('duplicate_stays',
    (SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]') FROM stays s WHERE s.contact_id = p_remove AND s.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM stays x WHERE x.contact_id = p_keep AND x.deleted_at IS NULL
                    AND same_stay(x, s))));
  -- feedback on a duplicate stay moves to the kept stay, unless that stay already has feedback
  UPDATE feedback f SET stay_id = x.id
    FROM stays s JOIN stays x ON x.contact_id = p_keep AND x.deleted_at IS NULL AND same_stay(x, s)
   WHERE s.contact_id = p_remove AND s.deleted_at IS NULL AND f.stay_id = s.id
     AND NOT EXISTS (SELECT 1 FROM feedback g WHERE g.stay_id = x.id AND g.deleted_at IS NULL);
  snap := snap || jsonb_build_object('duplicate_stay_feedback',
    (SELECT coalesce(jsonb_agg(to_jsonb(f) || jsonb_build_object('employee_mentions',
              (SELECT coalesce(jsonb_agg(to_jsonb(em)), '[]') FROM employee_mentions em WHERE em.feedback_id = f.id))), '[]')
       FROM feedback f JOIN stays s ON s.id = f.stay_id
      WHERE s.contact_id = p_remove AND s.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM stays x WHERE x.contact_id = p_keep AND x.deleted_at IS NULL AND same_stay(x, s))));
  UPDATE notes n SET stay_id = x.id
    FROM stays s JOIN stays x ON x.contact_id = p_keep AND x.deleted_at IS NULL AND same_stay(x, s)
   WHERE s.contact_id = p_remove AND s.deleted_at IS NULL AND n.stay_id = s.id;
  UPDATE preferences p SET stay_id = x.id
    FROM stays s JOIN stays x ON x.contact_id = p_keep AND x.deleted_at IS NULL AND same_stay(x, s)
   WHERE s.contact_id = p_remove AND s.deleted_at IS NULL AND p.stay_id = s.id;
  UPDATE leads e SET stay_id = x.id
    FROM stays s JOIN stays x ON x.contact_id = p_keep AND x.deleted_at IS NULL AND same_stay(x, s)
   WHERE s.contact_id = p_remove AND s.deleted_at IS NULL AND e.stay_id = s.id;
  DELETE FROM stays s WHERE s.contact_id = p_remove AND s.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM stays x WHERE x.contact_id = p_keep AND x.deleted_at IS NULL
                 AND same_stay(x, s));
  moved := moved || jsonb_build_object('stays', (SELECT coalesce(jsonb_agg(id), '[]') FROM stays WHERE contact_id = p_remove));
  UPDATE stays          SET contact_id = p_keep WHERE contact_id = p_remove;
  UPDATE preferences    SET contact_id = p_keep WHERE contact_id = p_remove;
  UPDATE notes          SET contact_id = p_keep WHERE contact_id = p_remove;
  UPDATE special_dates  SET contact_id = p_keep WHERE contact_id = p_remove;
  UPDATE leads          SET contact_id = p_keep WHERE contact_id = p_remove;
  UPDATE interactions   SET contact_id = p_keep WHERE contact_id = p_remove;
  UPDATE data_issues    SET contact_id = p_keep WHERE contact_id = p_remove;

  -- 3. emails & phones: drop exact duplicates, keep the kept record's primary
  DELETE FROM contact_methods m WHERE m.contact_id = p_remove AND m.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM contact_methods x WHERE x.contact_id = p_keep AND x.deleted_at IS NULL
                 AND x.kind = m.kind AND x.value = m.value);
  UPDATE contact_methods m SET is_primary = false WHERE m.contact_id = p_remove AND m.is_primary
     AND EXISTS (SELECT 1 FROM contact_methods x WHERE x.contact_id = p_keep AND x.deleted_at IS NULL
                 AND x.kind = m.kind AND x.is_primary);
  UPDATE contact_methods SET contact_id = p_keep WHERE contact_id = p_remove;

  -- 4. consents: opted_out > opted_in > not_opted_in > unknown
  UPDATE consents kc SET
         status = CASE WHEN 'opted_out' IN (kc.status, rc.status) THEN 'opted_out'
                       WHEN 'opted_in' IN (kc.status, rc.status) THEN 'opted_in'
                       WHEN 'not_opted_in' IN (kc.status, rc.status) THEN 'not_opted_in'
                       ELSE 'unknown' END,
         source   = coalesce(kc.source, rc.source),
         evidence = concat_ws(' | ', kc.evidence, 'merged: ' || rc.evidence),
         given_at = greatest(kc.given_at, rc.given_at)
    FROM consents rc
   WHERE kc.contact_id = p_keep AND kc.deleted_at IS NULL
     AND rc.contact_id = p_remove AND rc.deleted_at IS NULL AND rc.channel = kc.channel;
  DELETE FROM consents rc WHERE rc.contact_id = p_remove AND rc.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM consents kc WHERE kc.contact_id = p_keep AND kc.deleted_at IS NULL
                 AND kc.channel = rc.channel);
  UPDATE consents SET contact_id = p_keep WHERE contact_id = p_remove;

  -- 5. tags
  INSERT INTO contact_tags (contact_id, tag_id)
       SELECT p_keep, tag_id FROM contact_tags WHERE contact_id = p_remove ON CONFLICT DO NOTHING;
  DELETE FROM contact_tags WHERE contact_id = p_remove;

  -- 6. fill blanks on the kept record and combine flags
  SELECT count(*) INTO n_stays FROM stays
   WHERE contact_id = p_keep AND deleted_at IS NULL AND status = 'checked_out';
  UPDATE contacts SET
    -- keep the kept record's name; take the other name only if the kept record has none
    first_name      = CASE WHEN k.first_name IS NULL AND k.last_name IS NULL THEN r.first_name ELSE k.first_name END,
    last_name       = CASE WHEN k.first_name IS NULL AND k.last_name IS NULL THEN r.last_name  ELSE k.last_name  END,
    contact_type    = CASE WHEN 'guest' IN (k.contact_type, r.contact_type)
                                AND k.contact_type IN ('guest','lead') THEN 'guest' ELSE k.contact_type END,
    lifecycle_stage = CASE
        WHEN k.lifecycle_stage IN ('agent_contact','influencer') THEN k.lifecycle_stage
        WHEN n_stays >= 2 THEN 'repeat_guest'
        ELSE stage_rank[greatest(coalesce(array_position(stage_rank, k.lifecycle_stage), 1),
                                 coalesce(array_position(stage_rank, r.lifecycle_stage), 1))] END,
    market          = CASE WHEN k.market = 'unknown' THEN r.market ELSE k.market END,
    country_code    = coalesce(k.country_code, r.country_code),
    company_id      = coalesce(k.company_id, r.company_id),
    designation     = coalesce(k.designation, r.designation),
    vip_reason      = coalesce(k.vip_reason, r.vip_reason),
    status          = CASE WHEN 'do_not_contact' IN (k.status, r.status) THEN 'do_not_contact' ELSE k.status END
  WHERE id = p_keep;

  -- 7. log, then remove the duplicate
  INSERT INTO contact_merges (kept_contact_id, removed_contact_id, removed_snapshot, moved_rows, note)
       VALUES (p_keep, p_remove, snap, moved, p_note);
  DELETE FROM contacts WHERE id = p_remove;
  RETURN p_keep;
END;
$$ LANGUAGE plpgsql;
