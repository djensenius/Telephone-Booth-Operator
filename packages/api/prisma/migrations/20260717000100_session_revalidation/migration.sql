-- Periodically re-check operator sessions against the IdP. `lastValidatedAt`
-- records the last successful userinfo call; when it is older than
-- SESSION_REVALIDATE_SECONDS the session is re-validated on the next request,
-- so accounts deleted or removed from the operator group in Authentik stop
-- working within that interval instead of surviving for the full session TTL.
-- Nullable so existing sessions revalidate on their next request.

ALTER TABLE "OperatorSession" ADD COLUMN "lastValidatedAt" TIMESTAMP(3);
