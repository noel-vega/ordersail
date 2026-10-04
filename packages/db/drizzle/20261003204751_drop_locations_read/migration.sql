-- locations:read is gone from PERMISSIONS_CATALOG (OS-696): every staff member
-- can view locations. The boot-time catalog sync never deletes a removed key,
-- so drop its row here, or the role editor keeps offering a permission
-- nothing checks. role_permissions rows go with it (ON DELETE CASCADE).
DELETE FROM "permissions" WHERE "key" = 'locations:read';
