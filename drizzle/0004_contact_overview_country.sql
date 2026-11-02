-- Module 2 – the guest list filters by country code, so contact_overview gets
-- country_code. CREATE OR REPLACE VIEW can only add columns at the end, so the
-- existing columns are repeated unchanged, in the same order.
CREATE OR REPLACE VIEW contact_overview AS
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
       c.created_at, c.updated_at,
       c.country_code
FROM contacts c
LEFT JOIN companies co ON co.id = c.company_id AND co.deleted_at IS NULL
LEFT JOIN countries cn ON cn.code = c.country_code
WHERE c.deleted_at IS NULL;
