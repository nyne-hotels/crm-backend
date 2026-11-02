-- Functions, triggers and views from docs/schema.sql.
-- Drizzle can't express these, so they are kept as hand-written SQL.
-- Edit by adding a new custom migration (npm run db:generate -- --custom), never by changing this file.

-- ---------- who is making this change? ----------
CREATE OR REPLACE FUNCTION current_staff_id() RETURNS bigint AS $$
  SELECT nullif(current_setting('app.staff_id', true), '')::bigint
$$ LANGUAGE sql STABLE;

-- ---------- audit trigger for normal tables ----------
-- INSERT: stamps created_* and updated_*.
-- UPDATE: created_* can never change; updated_* is always refreshed;
--         deleted_by is stamped when a row is deleted and cleared when restored.
CREATE OR REPLACE FUNCTION set_audit_columns() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := coalesce(NEW.created_at, now());
    NEW.created_by := coalesce(current_staff_id(), NEW.created_by);
    NEW.updated_at := NEW.created_at;
    NEW.updated_by := NEW.created_by;
    IF NEW.deleted_at IS NOT NULL THEN
      NEW.deleted_by := coalesce(current_staff_id(), NEW.deleted_by);
    END IF;
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.updated_at := now();
    NEW.updated_by := coalesce(current_staff_id(),
                               CASE WHEN NEW.updated_by IS DISTINCT FROM OLD.updated_by THEN NEW.updated_by END);
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      NEW.deleted_by := coalesce(current_staff_id(), NEW.deleted_by);
    ELSIF NEW.deleted_at IS NULL THEN
      NEW.deleted_by := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------- audit trigger for the two insert-only tables ----------
CREATE OR REPLACE FUNCTION set_created_columns() RETURNS trigger AS $$
BEGIN
  NEW.created_at := coalesce(NEW.created_at, now());
  NEW.created_by := coalesce(current_staff_id(), NEW.created_by);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION notes_fill_contact() RETURNS trigger AS $$
BEGIN
  IF NEW.contact_id IS NULL AND NEW.stay_id IS NOT NULL THEN
    SELECT contact_id INTO NEW.contact_id FROM stays WHERE id = NEW.stay_id;
  END IF;
  IF NEW.contact_id IS NULL AND NEW.lead_id IS NOT NULL THEN
    SELECT contact_id INTO NEW.contact_id FROM leads WHERE id = NEW.lead_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER t_notes_fill_contact BEFORE INSERT OR UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION notes_fill_contact();

-- ---------- attach the audit triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_users','properties','countries','occasions','companies','contacts',
                           'contact_methods','special_dates','stays','preferences','consents','tags',
                           'employees','feedback','employee_mentions','leads','interactions','notes','data_issues'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_audit_columns()',
                   't_' || t || '_audit', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['contact_tags','contact_merges'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION set_created_columns()',
                   't_' || t || '_audit', t);
  END LOOP;
END $$;

-- ---------- lifecycle: a new stay moves the person forward ----------
-- 1 stay -> 'stayed', 2+ stays -> 'repeat_guest'. Never moves anyone backwards,
-- and never touches agent contacts or influencers.
CREATE OR REPLACE FUNCTION bump_lifecycle_on_stay() RETURNS trigger AS $$
BEGIN
  UPDATE contacts c
     SET lifecycle_stage = CASE WHEN (SELECT count(*) FROM stays s
                                       WHERE s.contact_id = NEW.contact_id AND s.deleted_at IS NULL) >= 2
                                THEN 'repeat_guest' ELSE 'stayed' END,
         contact_type    = CASE WHEN c.contact_type = 'lead' THEN 'guest' ELSE c.contact_type END
   WHERE c.id = NEW.contact_id
     AND c.lifecycle_stage IN ('lead','enquired','booked','stayed','stayed_hotel_unknown');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER t_stays_lifecycle AFTER INSERT ON stays FOR EACH ROW EXECUTE FUNCTION bump_lifecycle_on_stay();

-- ---------- unsubscribes always win ----------
CREATE OR REPLACE FUNCTION do_not_contact_blocks_marketing() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'do_not_contact' THEN
    UPDATE consents SET status = 'opted_out', given_at = now()
     WHERE contact_id = NEW.id AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER t_contacts_dnc AFTER UPDATE OF status ON contacts
  FOR EACH ROW WHEN (NEW.status = 'do_not_contact') EXECUTE FUNCTION do_not_contact_blocks_marketing();

-- ---------- are two stay rows the same visit? ----------
-- Same hotel and same booking reference; or, when either has no reference,
-- same hotel and same arrival date (both undated counts as the same).
CREATE OR REPLACE FUNCTION same_stay(a stays, b stays) RETURNS boolean AS $$
  SELECT a.property_id = b.property_id AND (
           (a.booking_reference IS NOT NULL AND a.booking_reference = b.booking_reference)
        OR ((a.booking_reference IS NULL OR b.booking_reference IS NULL)
            AND a.arrival_date IS NOT DISTINCT FROM b.arrival_date))
$$ LANGUAGE sql IMMUTABLE;

-- ---------- merge two contacts ----------
-- SELECT merge_contacts(keep_id, remove_id, 'optional note');
-- Moves everything from remove_id to keep_id, fills blanks on the kept
-- record, keeps the strictest consent (an opt-out is never lost), logs the
-- merge in contact_merges, then deletes the duplicate. All or nothing.
-- Who merged is taken from app.staff_id like every other change.
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
  SELECT count(*) INTO n_stays FROM stays WHERE contact_id = p_keep AND deleted_at IS NULL;
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

-- =====================================================================
-- VIEWS – all of them hide deleted rows
-- =====================================================================

-- Pairs of contacts that may be the same person, for staff to review and merge.
-- Same name is only a hint: two different guests can share a name.
CREATE VIEW possible_duplicates AS
SELECT a.id AS contact_a, concat_ws(' ', a.first_name, a.last_name) AS name_a,
       b.id AS contact_b, concat_ws(' ', b.first_name, b.last_name) AS name_b,
       string_agg(DISTINCT x.reason, ', ') AS reason
FROM (
  SELECT c1.id AS a, c2.id AS b, 'same name' AS reason
    FROM contacts c1 JOIN contacts c2 ON c1.id < c2.id
     AND length(concat_ws(' ', c1.first_name, c1.last_name)) > 5
     AND lower(concat_ws(' ', c1.first_name, c1.last_name)) = lower(concat_ws(' ', c2.first_name, c2.last_name))
  UNION ALL
  SELECT m1.contact_id, m2.contact_id, 'same ' || m1.kind
    FROM contact_methods m1 JOIN contact_methods m2
      ON m1.contact_id < m2.contact_id AND m1.kind = m2.kind AND lower(m1.value) = lower(m2.value)
   WHERE NOT m1.is_shared AND NOT m2.is_shared AND m1.deleted_at IS NULL AND m2.deleted_at IS NULL
) x
JOIN contacts a ON a.id = x.a AND a.deleted_at IS NULL
JOIN contacts b ON b.id = x.b AND b.deleted_at IS NULL
GROUP BY a.id, a.first_name, a.last_name, b.id, b.first_name, b.last_name;

-- One line per person with the things staff look at first
CREATE VIEW contact_overview AS
SELECT c.id, c.first_name, c.last_name, c.contact_type, c.lifecycle_stage,
       c.market, cn.name AS country, co.name AS company,
       (SELECT value FROM contact_methods m WHERE m.contact_id = c.id AND m.kind = 'email'
           AND m.is_primary AND m.deleted_at IS NULL) AS email,
       (SELECT value FROM contact_methods m WHERE m.contact_id = c.id AND m.kind = 'phone'
           AND m.is_primary AND m.deleted_at IS NULL) AS phone,
       (SELECT string_agg(DISTINCT p.name, ', ') FROM stays s JOIN properties p ON p.id = s.property_id
         WHERE s.contact_id = c.id AND s.deleted_at IS NULL) AS hotels,
       (SELECT count(*) FROM stays s WHERE s.contact_id = c.id AND s.deleted_at IS NULL) AS stay_rows,
       (SELECT max(s.arrival_date) FROM stays s WHERE s.contact_id = c.id AND s.deleted_at IS NULL) AS last_stay,
       (SELECT status FROM consents k WHERE k.contact_id = c.id AND k.channel = 'email'
           AND k.deleted_at IS NULL) AS email_consent,
       (SELECT string_agg(t.name, ', ') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
         WHERE ct.contact_id = c.id AND t.deleted_at IS NULL) AS tags,
       c.created_at, c.updated_at
FROM contacts c
LEFT JOIN companies co ON co.id = c.company_id AND co.deleted_at IS NULL
LEFT JOIN countries cn ON cn.code = c.country_code
WHERE c.deleted_at IS NULL;

-- Who may receive marketing email right now
CREATE VIEW marketing_email_list AS
SELECT c.id, c.first_name, c.last_name, m.value AS email, c.market, cn.name AS country, c.lifecycle_stage
FROM contacts c
LEFT JOIN countries cn ON cn.code = c.country_code
JOIN consents k        ON k.contact_id = c.id AND k.channel = 'email' AND k.status = 'opted_in'
                      AND k.deleted_at IS NULL
JOIN contact_methods m ON m.contact_id = c.id AND m.kind = 'email' AND m.is_primary
                      AND NOT m.is_shared AND m.status NOT IN ('bounced','invalid') AND m.deleted_at IS NULL
WHERE c.status = 'active' AND c.deleted_at IS NULL;

-- Occasions in the next 60 days (29 Feb falls on 1 Mar in non-leap years)
CREATE VIEW upcoming_special_dates AS
WITH d AS (
  SELECT sd.*,
         make_date(extract(year FROM current_date)::int, sd.month, 1) + (sd.day - 1) AS this_year,
         make_date(extract(year FROM current_date)::int + 1, sd.month, 1) + (sd.day - 1) AS next_year
  FROM special_dates sd
  WHERE sd.deleted_at IS NULL
), n AS (
  SELECT d.*, CASE WHEN this_year >= current_date THEN this_year ELSE next_year END AS next_date FROM d
)
SELECT n.next_date, n.next_date - current_date AS days_away, n.occasion, n.label,
       CASE WHEN n.year IS NOT NULL THEN extract(year FROM n.next_date)::int - n.year END AS turning_or_years,
       c.id AS contact_id, c.first_name, c.last_name, c.lifecycle_stage,
       (SELECT k.status FROM consents k WHERE k.contact_id = c.id AND k.channel = 'email'
           AND k.deleted_at IS NULL) AS email_consent
FROM n JOIN contacts c ON c.id = n.contact_id
WHERE c.status = 'active' AND c.deleted_at IS NULL AND n.next_date <= current_date + 60
ORDER BY n.next_date;

-- Every piece of feedback with the guest and hotel, newest first
CREATE VIEW feedback_overview AS
SELECT f.id, f.submitted_at, p.name AS hotel, s.arrival_date, s.departure_date,
       c.id AS contact_id, c.first_name, c.last_name, f.rating, f.review,
       (f.rating <= 2) AS needs_follow_up
FROM feedback f
JOIN stays s      ON s.id = f.stay_id AND s.deleted_at IS NULL
JOIN properties p ON p.id = s.property_id
JOIN contacts c   ON c.id = s.contact_id AND c.deleted_at IS NULL
WHERE f.deleted_at IS NULL
ORDER BY f.submitted_at DESC;

-- Every guest comment about an employee, newest first
CREATE VIEW employee_feedback AS
SELECT m.id, f.submitted_at, p.name AS hotel,
       e.id AS employee_id, concat_ws(' ', e.first_name, e.last_name) AS employee, e.department, e.job_title,
       m.name_as_written, m.sentiment, m.comment, f.rating AS stay_rating,
       c.id AS contact_id, concat_ws(' ', c.first_name, c.last_name) AS guest
FROM employee_mentions m
JOIN feedback f   ON f.id = m.feedback_id AND f.deleted_at IS NULL
JOIN stays s      ON s.id = f.stay_id AND s.deleted_at IS NULL
JOIN properties p ON p.id = s.property_id
JOIN contacts c   ON c.id = s.contact_id
LEFT JOIN employees e ON e.id = m.employee_id
WHERE m.deleted_at IS NULL
ORDER BY f.submitted_at DESC;

-- Per employee: how often guests praised or criticised them
CREATE VIEW employee_feedback_summary AS
SELECT e.id, concat_ws(' ', e.first_name, e.last_name) AS employee, p.name AS hotel, e.department, e.job_title,
       count(m.id) FILTER (WHERE m.sentiment = 'positive') AS positive,
       count(m.id) FILTER (WHERE m.sentiment = 'negative') AS negative,
       count(m.id) FILTER (WHERE m.sentiment = 'positive' AND f.submitted_at >= now() - interval '90 days') AS positive_90_days,
       count(m.id) FILTER (WHERE m.sentiment = 'negative' AND f.submitted_at >= now() - interval '90 days') AS negative_90_days,
       max(f.submitted_at) AS last_mentioned
FROM employees e
LEFT JOIN properties p ON p.id = e.property_id
LEFT JOIN employee_mentions m ON m.employee_id = e.id AND m.deleted_at IS NULL
LEFT JOIN feedback f ON f.id = m.feedback_id AND f.deleted_at IS NULL
WHERE e.deleted_at IS NULL
GROUP BY e.id, e.first_name, e.last_name, p.name, e.department, e.job_title;

-- Average rating per hotel, overall and for the last 90 days
CREATE VIEW property_ratings AS
SELECT p.id, p.name,
       count(f.id)                                                     AS responses,
       round(avg(f.rating), 2)                                         AS avg_rating,
       count(f.id) FILTER (WHERE f.rating <= 2)                        AS low_ratings,
       round(avg(f.rating) FILTER (WHERE f.submitted_at >= now() - interval '90 days'), 2) AS avg_rating_90_days,
       max(f.submitted_at)                                             AS last_response
FROM properties p
LEFT JOIN stays s    ON s.property_id = p.id AND s.deleted_at IS NULL
LEFT JOIN feedback f ON f.stay_id = s.id AND f.deleted_at IS NULL
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.name;

-- Guests per hotel
CREATE VIEW property_guest_counts AS
SELECT p.id, p.name, count(DISTINCT s.contact_id) AS guests, count(s.id) AS stay_rows,
       count(s.arrival_date) AS stays_with_dates
FROM properties p
LEFT JOIN stays s ON s.property_id = p.id AND s.deleted_at IS NULL
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.name;

