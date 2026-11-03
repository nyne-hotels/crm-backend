-- Campaigns – the database side (tables in 0019).
-- merge_contacts() already moves leads, so a campaign lead follows a merged guest.

-- ---------- audit trigger for the new table ----------
CREATE TRIGGER t_campaigns_audit BEFORE INSERT OR UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION set_audit_columns();
