-- Module 9 – the database side of the contact import.

-- ---------- audit triggers for the new tables ----------
CREATE TRIGGER t_contact_imports_audit BEFORE INSERT OR UPDATE ON contact_imports
  FOR EACH ROW EXECUTE FUNCTION set_audit_columns();--> statement-breakpoint
CREATE TRIGGER t_contact_import_changes_audit BEFORE INSERT ON contact_import_changes
  FOR EACH ROW EXECUTE FUNCTION set_created_columns();--> statement-breakpoint

-- ---------- the change log is never edited or deleted ----------
-- It is how an import's changes are put back by hand, so a changed row would
-- make that impossible to trust.
CREATE OR REPLACE FUNCTION contact_import_changes_are_final() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The contact import change log cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER t_contact_import_changes_final BEFORE UPDATE OR DELETE ON contact_import_changes
  FOR EACH ROW EXECUTE FUNCTION contact_import_changes_are_final();
