-- The assistant's default name is used in AI replies, so it must not carry a
-- product name. Rename rows still using the old default.
ALTER TABLE "AIAssistant" ALTER COLUMN "name" SET DEFAULT 'AI Assistant';
UPDATE "AIAssistant" SET "name" = 'AI Assistant' WHERE "name" = 'Unichat Assistant';
