-- Existing documents were uploaded by the server before their records existed.
ALTER TABLE public.documents
  ADD COLUMN upload_verified_at timestamptz DEFAULT now(),
  ADD COLUMN extraction_lease_until timestamptz;

-- Preserve status values. A newly prepared upload explicitly sets verification NULL.
-- Existing broad owner UPDATE permission must not permit forging verification,
-- changing storage identity, or stealing an extraction lease.
CREATE SCHEMA IF NOT EXISTS private;
CREATE FUNCTION private.protect_document_upload() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF auth.role() = 'authenticated' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Create documents through the upload authorization endpoint';
    END IF;
    IF OLD.upload_verified_at IS NULL AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'Upload must be verified before processing';
    END IF;
    IF ROW(NEW.id, NEW.user_id, NEW.storage_path, NEW.size_bytes,
           NEW.original_filename, NEW.created_at, NEW.upload_verified_at, NEW.extraction_lease_until)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.user_id, OLD.storage_path, OLD.size_bytes,
           OLD.original_filename, OLD.created_at, OLD.upload_verified_at, OLD.extraction_lease_until) THEN
      RAISE EXCEPTION 'Document upload identity and verification are server managed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_document_upload BEFORE INSERT OR UPDATE ON public.documents
FOR EACH ROW EXECUTE FUNCTION private.protect_document_upload();

CREATE INDEX documents_abandoned_uploads ON public.documents(created_at)
WHERE upload_verified_at IS NULL;

-- Storage RLS and rfps bucket settings deliberately remain unchanged.

-- Collect objects completed with an outstanding signed token after deletion.
CREATE TABLE public.document_upload_cleanup (
  storage_path text PRIMARY KEY,
  cleanup_after timestamptz NOT NULL DEFAULT (now() + interval '72 hours')
);
ALTER TABLE public.document_upload_cleanup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_upload_cleanup FROM anon, authenticated;
GRANT ALL ON public.document_upload_cleanup TO service_role;
CREATE FUNCTION private.remember_deleted_upload() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.document_upload_cleanup(storage_path) VALUES (OLD.storage_path)
  ON CONFLICT (storage_path) DO UPDATE SET cleanup_after = now() + interval '72 hours';
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION private.remember_deleted_upload() FROM PUBLIC;
CREATE TRIGGER remember_deleted_upload AFTER DELETE ON public.documents
FOR EACH ROW EXECUTE FUNCTION private.remember_deleted_upload();
