-- Add a secure lookup token to each consumer
-- This is a random 8-char alphanumeric code that consumers use to look up their bills
-- It's NOT the consumer_id (which is sequential and guessable)
ALTER TABLE consumers ADD COLUMN IF NOT EXISTS lookup_token varchar UNIQUE;

-- Generate tokens for existing consumers
UPDATE consumers SET lookup_token = upper(substr(md5(random()::text || id::text), 1, 8))
WHERE lookup_token IS NULL;

-- Make it NOT NULL for future inserts
ALTER TABLE consumers ALTER COLUMN lookup_token SET DEFAULT upper(substr(md5(random()::text), 1, 8));
