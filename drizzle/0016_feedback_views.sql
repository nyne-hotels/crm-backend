-- Module 8 – the feedback views.
--   feedback_overview: "needs follow-up" is a rating of 1 or 2 not yet
--     followed up; adds the stay, hotel id, follow-up date and mention count.
--   employee_feedback_summary: counts only mentions on live feedback of live
--     stays and guests (a deleted response no longer counts); adds the hotel
--     id and whether the employee is still working.
--   property_ratings: leaves out feedback of deleted guests; adds responses in
--     the last 90 days and how many still need follow-up.
-- New columns go at the end, so CREATE OR REPLACE keeps anything built on them.

CREATE OR REPLACE VIEW feedback_overview AS
SELECT f.id, f.submitted_at, p.name AS hotel, s.arrival_date, s.departure_date,
       c.id AS contact_id, c.first_name, c.last_name, f.rating, f.review,
       (coalesce(f.rating <= 2, false) AND f.followed_up_at IS NULL) AS needs_follow_up,
       s.id AS stay_id, s.property_id, f.followed_up_at,
       (SELECT count(*) FROM employee_mentions m WHERE m.feedback_id = f.id AND m.deleted_at IS NULL) AS mentions
FROM feedback f
JOIN stays s      ON s.id = f.stay_id AND s.deleted_at IS NULL
JOIN properties p ON p.id = s.property_id
JOIN contacts c   ON c.id = s.contact_id AND c.deleted_at IS NULL
WHERE f.deleted_at IS NULL
ORDER BY f.submitted_at DESC;--> statement-breakpoint

CREATE OR REPLACE VIEW employee_feedback_summary AS
SELECT e.id, concat_ws(' ', e.first_name, e.last_name) AS employee, p.name AS hotel, e.department, e.job_title,
       count(m.id) FILTER (WHERE m.sentiment = 'positive') AS positive,
       count(m.id) FILTER (WHERE m.sentiment = 'negative') AS negative,
       count(m.id) FILTER (WHERE m.sentiment = 'positive' AND m.submitted_at >= now() - interval '90 days') AS positive_90_days,
       count(m.id) FILTER (WHERE m.sentiment = 'negative' AND m.submitted_at >= now() - interval '90 days') AS negative_90_days,
       max(m.submitted_at) AS last_mentioned,
       e.property_id, e.is_active
FROM employees e
LEFT JOIN properties p ON p.id = e.property_id
LEFT JOIN (SELECT em.id, em.employee_id, em.sentiment, f.submitted_at
             FROM employee_mentions em
             JOIN feedback f ON f.id = em.feedback_id AND f.deleted_at IS NULL
             JOIN stays s    ON s.id = f.stay_id AND s.deleted_at IS NULL
             JOIN contacts c ON c.id = s.contact_id AND c.deleted_at IS NULL
            WHERE em.deleted_at IS NULL) m ON m.employee_id = e.id
WHERE e.deleted_at IS NULL
GROUP BY e.id, e.first_name, e.last_name, p.name, e.department, e.job_title, e.property_id, e.is_active;--> statement-breakpoint

CREATE OR REPLACE VIEW property_ratings AS
SELECT p.id, p.name,
       count(f.id)                                                     AS responses,
       round(avg(f.rating), 2)                                         AS avg_rating,
       count(f.id) FILTER (WHERE f.rating <= 2)                        AS low_ratings,
       round(avg(f.rating) FILTER (WHERE f.submitted_at >= now() - interval '90 days'), 2) AS avg_rating_90_days,
       max(f.submitted_at)                                             AS last_response,
       count(f.id) FILTER (WHERE f.submitted_at >= now() - interval '90 days') AS responses_90_days,
       count(f.id) FILTER (WHERE f.rating <= 2 AND f.followed_up_at IS NULL) AS needs_follow_up
FROM properties p
LEFT JOIN (SELECT s.property_id, x.id, x.rating, x.submitted_at, x.followed_up_at
             FROM feedback x
             JOIN stays s    ON s.id = x.stay_id AND s.deleted_at IS NULL
             JOIN contacts c ON c.id = s.contact_id AND c.deleted_at IS NULL
            WHERE x.deleted_at IS NULL) f ON f.property_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.name;
