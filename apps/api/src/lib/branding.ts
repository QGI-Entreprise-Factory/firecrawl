import { config } from "../config";

/**
 * Central branding module (Qrawlex, formerly Firecrawl).
 *
 * All user-facing strings that mention the product name, support contact or
 * dashboard should use these constants so a rebrand stays a one-file change.
 */
export const BRAND_NAME = "Qrawlex";

export const SUPPORT_EMAIL = "support@qrawlex.com";

/** Dashboard base URL — configurable via QRAWLEX_DASHBOARD_URL (legacy: FIRECRAWL_DASHBOARD_URL). */
export const DASHBOARD_URL = config.FIRECRAWL_DASHBOARD_URL;
