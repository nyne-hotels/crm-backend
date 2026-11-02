-- Module 4 – the Upcoming occasions page reads upcoming_special_dates.
--
-- "Today" becomes the date in Colombo, like the stays lists (Module 3), so the
-- list doesn't change over at midnight UTC. Columns the page needs are added at
-- the end (CREATE OR REPLACE VIEW can only add columns there); the existing ones
-- are unchanged, in the same order:
--   special_date_id, year       – the row behind each line
--   can_email                   – on marketing_email_list right now
--   next_stay_*                 – the guest's next live booking (booked or in house)
--   last_stay_*                 – their last checked-out stay
-- The 60-day window, the 29 February rule and the active, not-deleted guests are as before.
CREATE OR REPLACE VIEW upcoming_special_dates AS
WITH t AS (
  SELECT (now() AT TIME ZONE 'Asia/Colombo')::date AS today
), d AS (
  SELECT sd.*, t.today,
         make_date(extract(year FROM t.today)::int, sd.month, 1) + (sd.day - 1) AS this_year,
         make_date(extract(year FROM t.today)::int + 1, sd.month, 1) + (sd.day - 1) AS next_year
  FROM special_dates sd CROSS JOIN t
  WHERE sd.deleted_at IS NULL
), n AS (
  SELECT d.*, CASE WHEN this_year >= today THEN this_year ELSE next_year END AS next_date FROM d
)
SELECT n.next_date, n.next_date - n.today AS days_away, n.occasion, n.label,
       CASE WHEN n.year IS NOT NULL THEN extract(year FROM n.next_date)::int - n.year END AS turning_or_years,
       c.id AS contact_id, c.first_name, c.last_name, c.lifecycle_stage,
       (SELECT k.status FROM consents k WHERE k.contact_id = c.id AND k.channel = 'email'
           AND k.deleted_at IS NULL) AS email_consent,
       n.id AS special_date_id, n.year,
       EXISTS (SELECT 1 FROM marketing_email_list ml WHERE ml.id = c.id) AS can_email,
       ns.id AS next_stay_id, ns.arrival_date AS next_stay_arrival,
       ns.property_id AS next_stay_property_id, np.name AS next_stay_hotel,
       ls.property_id AS last_stay_property_id, lp.name AS last_stay_hotel
FROM n
JOIN contacts c ON c.id = n.contact_id
LEFT JOIN LATERAL (
  SELECT s.id, s.arrival_date, s.property_id FROM stays s
   WHERE s.contact_id = c.id AND s.deleted_at IS NULL AND s.status IN ('booked','checked_in')
     AND (s.departure_date IS NULL OR s.departure_date >= n.today)
   ORDER BY s.arrival_date NULLS LAST, s.id
   LIMIT 1
) ns ON true
LEFT JOIN properties np ON np.id = ns.property_id
LEFT JOIN LATERAL (
  SELECT s.property_id FROM stays s
   WHERE s.contact_id = c.id AND s.deleted_at IS NULL AND s.status = 'checked_out'
   ORDER BY s.arrival_date DESC NULLS LAST, s.id DESC
   LIMIT 1
) ls ON true
LEFT JOIN properties lp ON lp.id = ls.property_id
WHERE c.status = 'active' AND c.deleted_at IS NULL AND n.next_date <= n.today + 60
ORDER BY n.next_date;
