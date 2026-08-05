-- Migration 074: New Connection Request now collects the exact same consumer
-- profile fields Add Consumer (billing page) already does, so a consumer
-- created via either path ends up with equally complete data.
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS father_husband_name varchar;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS whatsapp_number varchar;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS whatsapp_same_as_mobile boolean NOT NULL DEFAULT true;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS house_no varchar;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS area varchar;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS connections integer NOT NULL DEFAULT 1;
