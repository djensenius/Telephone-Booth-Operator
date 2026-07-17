-- Two-tier operator access. `isAdmin` is derived from admin-group membership
-- at each login (cookie flow) / bearer-token validation (mobile flow), so the
-- column is a cache of the last computed value rather than the source of
-- truth. Defaults to false so existing operators remain non-admin until they
-- log in again while a member of an admin group.

ALTER TABLE "OperatorUser" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
