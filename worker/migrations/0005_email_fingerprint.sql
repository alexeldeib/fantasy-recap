-- The editor-link mailbox (src/mail.ts): a fingerprint of the email a pass was bought with, never the address itself.
ALTER TABLE leagues ADD COLUMN email_hash TEXT;
