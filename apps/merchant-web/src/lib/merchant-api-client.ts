import { AdminClient } from "merchant-sdk";

export const merchantApi = new AdminClient(
  import.meta.env.VITE_MERCHANT_API_BASE_URL,
);
