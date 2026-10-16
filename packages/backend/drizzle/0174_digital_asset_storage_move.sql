-- oxy:deploy-phase=pre
-- oxy:rollback=restore: mercaria_asset_file_immutable() comes back from its 0156 definition (digital_immutability_triggers), which also refused a storage_key move on a published file.
-- A published asset file's BYTES stay immutable (#1015 W12 threat 8: no swap
-- after a sale) — `content_hash`, `byte_size` and `media_type` are still refused
-- — but WHERE those bytes are stored may move: a creator's upload is copied into
-- an application-owned PRIVATE Oxy file (Oxy ADR 0041 D3/D5) so serving no
-- longer depends on the creator's link (ADR 0021). A `storage_key` change on a
-- published file is still refused UNLESS the transaction declared that move for
-- exactly that row (`set_config('mercaria.asset_storage_move', <file id>, true)`)
-- — which only `replaceAssetFileStorageKey` does, after the new object was
-- MEASURED to hold the same SHA-256. A stray UPDATE is refused as before, and
-- the hash, size and type stay refused even inside a declared move.
-- oxy:handwritten-begin=digital_asset_storage_move
CREATE OR REPLACE FUNCTION mercaria_asset_file_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  published_at_value timestamptz;
BEGIN
  SELECT v.published_at INTO published_at_value
    FROM asset_versions v
   WHERE v.id = COALESCE(OLD.version_id, NEW.version_id);
  IF published_at_value IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'asset file % belongs to a published version and is never deleted: a buyer holding a right to it would lose the bytes they paid for.',
      OLD.file_name
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version_id IS DISTINCT FROM OLD.version_id OR
     NEW.file_name IS DISTINCT FROM OLD.file_name OR
     NEW.format IS DISTINCT FROM OLD.format OR
     NEW.media_type IS DISTINCT FROM OLD.media_type OR
     NEW.role IS DISTINCT FROM OLD.role OR
     NEW.visibility IS DISTINCT FROM OLD.visibility OR
     NEW.byte_size IS DISTINCT FROM OLD.byte_size OR
     NEW.content_hash IS DISTINCT FROM OLD.content_hash OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     (NEW.storage_key IS DISTINCT FROM OLD.storage_key AND
      current_setting('mercaria.asset_storage_move', true) IS DISTINCT FROM OLD.id)
  THEN
    RAISE EXCEPTION
      'asset file % belongs to a published version: its contents and visibility are immutable. Publish a new version instead.',
      OLD.file_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- oxy:handwritten-end=digital_asset_storage_move
