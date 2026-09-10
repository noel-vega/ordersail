export interface PermissionDef {
  key: string;
  resource: string;
  action: string;
  description: string;
}

// fixed catalog of everything a role can be granted — new permissions ship
// as a code change (upserted at boot), never created through the API
export const PERMISSIONS_CATALOG: PermissionDef[] = [
  { key: "roles:read", resource: "roles", action: "read", description: "View roles and their permissions" },
  { key: "roles:write", resource: "roles", action: "write", description: "Create, edit, and delete roles" },

  { key: "users:read", resource: "users", action: "read", description: "View staff members" },
  { key: "users:write", resource: "users", action: "write", description: "Invite staff members" },
  { key: "users:manage_roles", resource: "users", action: "manage_roles", description: "Assign roles to staff members" },
  { key: "users:deactivate", resource: "users", action: "deactivate", description: "Deactivate and reactivate staff members" },

  { key: "customers:read", resource: "customers", action: "read", description: "View customers" },
  { key: "customers:write", resource: "customers", action: "write", description: "Edit customers" },

  { key: "orders:read", resource: "orders", action: "read", description: "View orders" },
  { key: "orders:write", resource: "orders", action: "write", description: "Edit orders" },
  { key: "orders:refund", resource: "orders", action: "refund", description: "Refund orders" },
  { key: "orders:cancel", resource: "orders", action: "cancel", description: "Cancel orders" },

  { key: "fulfillments:write", resource: "fulfillments", action: "write", description: "Fulfill orders" },

  { key: "products:read", resource: "products", action: "read", description: "View products" },
  { key: "products:write", resource: "products", action: "write", description: "Create and edit products" },
  { key: "products:delete", resource: "products", action: "delete", description: "Delete products" },

  { key: "inventory:read", resource: "inventory", action: "read", description: "View inventory levels" },
  { key: "inventory:write", resource: "inventory", action: "write", description: "Adjust inventory levels" },

  { key: "locations:read", resource: "locations", action: "read", description: "View locations" },
  { key: "locations:write", resource: "locations", action: "write", description: "Create and edit locations" },

  { key: "api_keys:read", resource: "api_keys", action: "read", description: "View API keys" },
  { key: "api_keys:write", resource: "api_keys", action: "write", description: "Create and revoke API keys" },

  { key: "pos_devices:read", resource: "pos_devices", action: "read", description: "View POS devices" },
  { key: "pos_devices:write", resource: "pos_devices", action: "write", description: "Pair, rename, and revoke POS devices" },

  { key: "payments:read", resource: "payments", action: "read", description: "View payment / payout status" },
  { key: "payments:write", resource: "payments", action: "write", description: "Connect and manage the Stripe account" },

  { key: "account:read", resource: "account", action: "read", description: "View account settings" },
  { key: "account:write", resource: "account", action: "write", description: "Edit account settings" },
];
