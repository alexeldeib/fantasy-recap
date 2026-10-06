-- The commissioner's editor: a private key per league (the editor link's ?key=), inherited by a renewed league.
ALTER TABLE leagues ADD COLUMN edit_key TEXT;
UPDATE leagues SET edit_key = lower(hex(randomblob(16))) WHERE paid_via IS NOT NULL AND paid_via != 'showcase';
