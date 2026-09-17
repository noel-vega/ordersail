-- OS-476: emailed single-use tokens are now stored only as their SHA-256 hex
-- digest (merchant-api hashToken()). Hash outstanding rows in place instead
-- of deleting them, so links already sitting in inboxes keep working across
-- the deploy. Must match hashToken(): sha256 over the UTF-8 bytes, hex.
-- The regex guard skips anything already a 64-char hex digest, so a re-run
-- (or a row written by new code before this ran) is never double-hashed;
-- generateToken(32) output is 43-char base64url and can never match it.
UPDATE "user_invites"
SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "token" !~ '^[0-9a-f]{64}$';
--> statement-breakpoint
UPDATE "user_password_resets"
SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "token" !~ '^[0-9a-f]{64}$';
--> statement-breakpoint
UPDATE "user_email_verifications"
SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "token" !~ '^[0-9a-f]{64}$';
