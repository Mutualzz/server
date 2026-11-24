-- Custom SQL migration file, put your code below! --
INSERT INTO "message_mentions" ("targetId", "messageId", "type", "channelId", "spaceId", "authorId")
SELECT
  CASE WHEN mention->>'type' = 'everyone' THEN messages."spaceId" ELSE (mention->>'id')::bigint END,
  messages.id,
  mention->>'type',
  messages."channelId",
  messages."spaceId",
  messages."authorId"
FROM messages, jsonb_array_elements(messages.mentions) AS mention
WHERE mention->>'type' IN ('user', 'role')
   OR (mention->>'type' = 'everyone' AND messages."spaceId" IS NOT NULL)
ON CONFLICT DO NOTHING;