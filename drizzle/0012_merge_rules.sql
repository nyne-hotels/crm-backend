-- Module 6 – duplicates and merging.
--   possible_duplicates – leaves out pairs marked "Not a duplicate", matches phones by
--                         their digits, and says which of name, email and phone match
--   merge_contacts      – carries do-not-contact over with its original date and author,
--                         takes consent source, wording and date from the row whose
--                         status won, keeps a full copy of the removed guest, moves
--                         "Not a duplicate" decisions, and recalculates the stage
--   do-not-contact      – the two triggers leave a merge's carried-over request as it was

-- ---------- audit trigger for the new table ----------
CREATE TRIGGER t_not_duplicates_audit BEFORE INSERT ON not_duplicates
  FOR EACH ROW EXECUTE FUNCTION set_created_columns();--> statement-breakpoint

-- ---------- do-not-contact: a date already on the row keeps its author too ----------
-- Before, a carried-over date kept its day but took the merging staff member as
-- the one who marked it. The app never writes these columns, so a date on the
-- row when the status changes can only come from a merge.
CREATE OR REPLACE FUNCTION stamp_do_not_contact() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'do_not_contact' THEN
    IF (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'do_not_contact') AND NEW.do_not_contact_at IS NULL THEN
      NEW.do_not_contact_at := now();
      NEW.do_not_contact_by := current_staff_id();
    END IF;
  ELSE
    NEW.do_not_contact_at := NULL;
    NEW.do_not_contact_by := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ---------- do-not-contact switches every channel to opted out (except in a merge) ----------
-- Unchanged from 0010, except that merge_contacts sets app.merging: the removed
-- guest's consents were switched when they asked, and the merge combines them
-- itself, so they keep that date instead of the merge's.
CREATE OR REPLACE FUNCTION do_not_contact_blocks_marketing() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.merging', true) = 'on' THEN
    RETURN NEW;
  END IF;
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

-- ---------- are two emails or phones the same? ----------
-- Emails ignoring case and spaces, phones by their digits ('+94 77 123 4567'
-- and '+94771234567'), as matchKey() in guest-rules.ts.
CREATE OR REPLACE FUNCTION contact_method_key(p_kind text, p_value text) RETURNS text AS $$
  SELECT CASE WHEN p_kind = 'email' THEN lower(regexp_replace(p_value, '\s+', '', 'g'))
              ELSE regexp_replace(p_value, '[^0-9]', '', 'g') END
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint

-- ---------- merge two contacts ----------
-- SELECT merge_contacts(keep_id, remove_id, 'optional note');
-- Moves everything from remove_id to keep_id, fills blanks on the kept record,
-- keeps the strictest consent (an opt-out is never lost), logs the merge in
-- contact_merges with a full copy of the removed guest, then deletes the
-- duplicate. All or nothing. Who merged is taken from app.staff_id.
CREATE OR REPLACE FUNCTION merge_contacts(p_keep bigint, p_remove bigint, p_note text DEFAULT NULL)
RETURNS bigint AS $$
DECLARE
  k contacts%ROWTYPE;
  r contacts%ROWTYPE;
  snap jsonb;
  moved jsonb;
  stage_rank text[] := ARRAY['lead','enquired','booked','stayed_hotel_unknown','stayed','repeat_guest'];
  -- strictest last: opted out, then opted in, then not opted in, then unknown
  consent_rank text[] := ARRAY['unknown','not_opted_in','opted_in','opted_out'];
  n_stays int;
  dnc_from_removed boolean;
BEGIN
  IF p_keep = p_remove THEN RAISE EXCEPTION 'Cannot merge a contact into itself'; END IF;
  -- lock both in id order, so two merges of the same pair can't deadlock
  PERFORM 1 FROM contacts WHERE id IN (p_keep, p_remove) ORDER BY id FOR UPDATE;
  SELECT * INTO k FROM contacts WHERE id = p_keep   AND deleted_at IS NULL;
  SELECT * INTO r FROM contacts WHERE id = p_remove AND deleted_at IS NULL;
  IF k.id IS NULL THEN RAISE EXCEPTION 'Contact % to keep does not exist', p_keep; END IF;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Contact % to remove does not exist', p_remove; END IF;
  PERFORM set_config('app.merging', 'on', true);

  -- 1. a full copy of the record being removed, and the kept record as it was
  snap := jsonb_build_object(
    'contact',         to_jsonb(r),
    'contact_methods', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]') FROM contact_methods m WHERE m.contact_id = p_remove),
    'consents',        (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]') FROM consents c WHERE c.contact_id = p_remove),
    'tags',            (SELECT coalesce(jsonb_agg(t.name ORDER BY t.name), '[]') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
                         WHERE ct.contact_id = p_remove),
    'stays',           (SELECT coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('hotel', p.name)
                                         ORDER BY s.arrival_date DESC NULLS LAST, s.id DESC), '[]')
                          FROM stays s JOIN properties p ON p.id = s.property_id WHERE s.contact_id = p_remove),
    'preferences',     (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM preferences x   WHERE x.contact_id = p_remove),
    'notes',           (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM notes x         WHERE x.contact_id = p_remove),
    'special_dates',   (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM special_dates x WHERE x.contact_id = p_remove),
    'leads',           (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM leads x         WHERE x.contact_id = p_remove),
    'interactions',    (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM interactions x  WHERE x.contact_id = p_remove),
    'kept_before',     jsonb_build_object(
                         'contact',  to_jsonb(k),
                         'consents', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]') FROM consents c
                                       WHERE c.contact_id = p_keep AND c.deleted_at IS NULL)));
  moved := jsonb_build_object(
    'preferences',    (SELECT coalesce(jsonb_agg(id), '[]') FROM preferences    WHERE contact_id = p_remove),
    'notes',          (SELECT coalesce(jsonb_agg(id), '[]') FROM notes          WHERE contact_id = p_remove),
    'special_dates',  (SELECT coalesce(jsonb_agg(id), '[]') FROM special_dates  WHERE contact_id = p_remove),
    'leads',          (SELECT coalesce(jsonb_agg(id), '[]') FROM leads          WHERE contact_id = p_remove),
    'interactions',   (SELECT coalesce(jsonb_agg(id), '[]') FROM interactions   WHERE contact_id = p_remove),
    'data_issues',    (SELECT coalesce(jsonb_agg(id), '[]') FROM data_issues    WHERE contact_id = p_remove),
    'contact_methods',(SELECT coalesce(jsonb_agg(m.id), '[]') FROM contact_methods m WHERE m.contact_id = p_remove
                         AND NOT (m.deleted_at IS NULL AND EXISTS (
                               SELECT 1 FROM contact_methods x WHERE x.contact_id = p_keep AND x.deleted_at IS NULL
                                  AND x.kind = m.kind
                                  AND contact_method_key(x.kind, x.value) = contact_method_key(m.kind, m.value)))));

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

  -- 3. emails & phones: drop exact duplicates (ignoring case, spaces and phone punctuation),
  --    keep the kept record's primary. A dropped copy still fills in what the kept one
  --    doesn't know: whether the number is on WhatsApp, and a checked status.
  UPDATE contact_methods x SET
         is_whatsapp = coalesce(x.is_whatsapp, m.is_whatsapp),
         status      = CASE WHEN x.status = 'unverified' THEN m.status ELSE x.status END
    FROM contact_methods m
   WHERE x.contact_id = p_keep AND x.deleted_at IS NULL
     AND m.contact_id = p_remove AND m.deleted_at IS NULL AND m.kind = x.kind
     AND contact_method_key(m.kind, m.value) = contact_method_key(x.kind, x.value)
     AND (x.is_whatsapp IS NULL AND m.is_whatsapp IS NOT NULL OR x.status = 'unverified' AND m.status <> 'unverified');
  DELETE FROM contact_methods m WHERE m.contact_id = p_remove AND m.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM contact_methods x WHERE x.contact_id = p_keep AND x.deleted_at IS NULL
                 AND x.kind = m.kind AND contact_method_key(x.kind, x.value) = contact_method_key(m.kind, m.value));
  UPDATE contact_methods m SET is_primary = false WHERE m.contact_id = p_remove AND m.is_primary
     AND EXISTS (SELECT 1 FROM contact_methods x WHERE x.contact_id = p_keep AND x.deleted_at IS NULL
                 AND x.kind = m.kind AND x.is_primary);
  UPDATE contact_methods SET contact_id = p_keep WHERE contact_id = p_remove;

  -- 4. consents, per channel: the strictest status wins (opted_out > opted_in > not_opted_in
  --    > unknown), and its source, wording and date come with it. With the same status on
  --    both, the later choice is kept (the latest explicit choice wins).
  UPDATE consents kc SET status = rc.status, source = rc.source, evidence = rc.evidence, given_at = rc.given_at
    FROM consents rc
   WHERE kc.contact_id = p_keep AND kc.deleted_at IS NULL
     AND rc.contact_id = p_remove AND rc.deleted_at IS NULL AND rc.channel = kc.channel
     AND (array_position(consent_rank, rc.status) > array_position(consent_rank, kc.status)
          OR (rc.status = kc.status AND rc.given_at > coalesce(kc.given_at, '-infinity')));
  DELETE FROM consents rc WHERE rc.contact_id = p_remove AND rc.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM consents kc WHERE kc.contact_id = p_keep AND kc.deleted_at IS NULL
                 AND kc.channel = rc.channel);
  UPDATE consents SET contact_id = p_keep WHERE contact_id = p_remove;

  -- 5. tags, and the pairs staff marked "Not a duplicate": someone who isn't the removed
  --    guest isn't the kept guest either, so the pair doesn't come back
  INSERT INTO contact_tags (contact_id, tag_id)
       SELECT p_keep, tag_id FROM contact_tags WHERE contact_id = p_remove ON CONFLICT DO NOTHING;
  DELETE FROM contact_tags WHERE contact_id = p_remove;
  INSERT INTO not_duplicates (contact_a, contact_b)
       SELECT least(p_keep, other), greatest(p_keep, other)
         FROM (SELECT CASE WHEN contact_a = p_remove THEN contact_b ELSE contact_a END AS other
                 FROM not_duplicates WHERE p_remove IN (contact_a, contact_b)) d
        WHERE other <> p_keep
       ON CONFLICT DO NOTHING;
  DELETE FROM not_duplicates WHERE p_remove IN (contact_a, contact_b);

  -- 6. fill blanks on the kept record and combine flags
  SELECT count(*) INTO n_stays FROM stays
   WHERE contact_id = p_keep AND deleted_at IS NULL AND status = 'checked_out';
  -- do not contact carries over with the date the guest first asked, and who marked it
  dnc_from_removed := r.status = 'do_not_contact'
    AND (k.status <> 'do_not_contact' OR r.do_not_contact_at < k.do_not_contact_at);
  IF 'do_not_contact' IN (k.status, r.status) THEN
    -- a channel neither record had a row for is opted out too, as the request did
    INSERT INTO consents (contact_id, channel, status, source, evidence, given_at)
    SELECT p_keep, ch, 'opted_out', 'do_not_contact', 'Asked not to be contacted',
           CASE WHEN dnc_from_removed THEN r.do_not_contact_at ELSE k.do_not_contact_at END
      FROM unnest(ARRAY['email', 'whatsapp']) AS ch
     WHERE NOT EXISTS (SELECT 1 FROM consents c WHERE c.contact_id = p_keep AND c.channel = ch
                         AND c.deleted_at IS NULL);
  END IF;
  UPDATE contacts SET
    -- keep the kept record's name; take the other name only if the kept record has none,
    -- or its surname when the first names agree and the kept record has no surname
    first_name      = CASE WHEN k.first_name IS NULL AND k.last_name IS NULL THEN r.first_name ELSE k.first_name END,
    last_name       = CASE WHEN k.first_name IS NULL AND k.last_name IS NULL THEN r.last_name
                           WHEN k.last_name IS NULL AND lower(k.first_name) = lower(r.first_name) THEN r.last_name
                           ELSE k.last_name END,
    contact_type    = CASE WHEN 'guest' IN (k.contact_type, r.contact_type)
                                AND k.contact_type IN ('guest','lead') THEN 'guest' ELSE k.contact_type END,
    -- from the combined checked-out stays; with none, the further of the two stages
    lifecycle_stage = CASE
        WHEN k.lifecycle_stage IN ('agent_contact','influencer') THEN k.lifecycle_stage
        WHEN n_stays >= 2 THEN 'repeat_guest'
        WHEN n_stays = 1 THEN 'stayed'
        ELSE stage_rank[greatest(coalesce(array_position(stage_rank, k.lifecycle_stage), 1),
                                 coalesce(array_position(stage_rank, r.lifecycle_stage), 1))] END,
    market          = CASE WHEN k.market = 'unknown' THEN r.market ELSE k.market END,
    country_code    = coalesce(k.country_code, r.country_code),
    company_id      = coalesce(k.company_id, r.company_id),
    designation     = coalesce(k.designation, r.designation),
    vip_reason      = coalesce(k.vip_reason, r.vip_reason),
    status          = CASE WHEN 'do_not_contact' IN (k.status, r.status) THEN 'do_not_contact' ELSE k.status END,
    do_not_contact_at = CASE WHEN dnc_from_removed THEN r.do_not_contact_at ELSE k.do_not_contact_at END,
    do_not_contact_by = CASE WHEN dnc_from_removed THEN r.do_not_contact_by ELSE k.do_not_contact_by END
  WHERE id = p_keep;

  -- 7. log, then remove the duplicate
  INSERT INTO contact_merges (kept_contact_id, removed_contact_id, removed_snapshot, moved_rows, note)
       VALUES (p_keep, p_remove, snap, moved, p_note);
  DELETE FROM contacts WHERE id = p_remove;
  PERFORM set_config('app.merging', '', true);
  RETURN p_keep;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ---------- possible_duplicates ----------
-- Pairs of contacts that may be the same person, for staff to review and merge.
-- Same name is only a hint: two different guests can share a name. Shared
-- emails and phones (an agent's office, a family number) never match. Pairs
-- staff marked "Not a duplicate" are left out. The first five columns are as
-- before; same_name / same_email / same_phone say which reasons apply.
CREATE OR REPLACE VIEW possible_duplicates AS
WITH named AS (
  SELECT id, lower(regexp_replace(trim(concat_ws(' ', first_name, last_name)), '\s+', ' ', 'g')) AS name_key
    FROM contacts WHERE deleted_at IS NULL
), methods AS (
  SELECT contact_id, kind, contact_method_key(kind, value) AS match_key
    FROM contact_methods WHERE NOT is_shared AND deleted_at IS NULL
), pairs AS (
  SELECT c1.id AS a, c2.id AS b, 'name' AS reason
    FROM named c1 JOIN named c2 ON c1.name_key = c2.name_key AND c1.id < c2.id
   WHERE length(c1.name_key) > 5
  UNION ALL
  SELECT m1.contact_id, m2.contact_id, m1.kind
    FROM methods m1 JOIN methods m2
      ON m1.kind = m2.kind AND m1.match_key = m2.match_key AND m1.contact_id < m2.contact_id
   -- a phone needs enough digits to mean something ('0' or '-' isn't a number)
   WHERE m1.kind = 'email' OR length(m1.match_key) >= 7
)
SELECT a.id AS contact_a, concat_ws(' ', a.first_name, a.last_name) AS name_a,
       b.id AS contact_b, concat_ws(' ', b.first_name, b.last_name) AS name_b,
       string_agg(DISTINCT 'same ' || x.reason, ', ') AS reason,
       bool_or(x.reason = 'name')  AS same_name,
       bool_or(x.reason = 'email') AS same_email,
       bool_or(x.reason = 'phone') AS same_phone
FROM pairs x
JOIN contacts a ON a.id = x.a AND a.deleted_at IS NULL
JOIN contacts b ON b.id = x.b AND b.deleted_at IS NULL
WHERE NOT EXISTS (SELECT 1 FROM not_duplicates d WHERE d.contact_a = x.a AND d.contact_b = x.b)
GROUP BY a.id, a.first_name, a.last_name, b.id, b.first_name, b.last_name;
