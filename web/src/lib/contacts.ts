/**
 * VisionSwap's public email addresses (owner's choice, October 2026):
 *
 *   support@visionswap.net   help with the app, legal and compliance requests, requests from
 *                            authorities, stolen-funds reports, security reports and privacy requests
 *   business@visionswap.net  business, partnership and press enquiries
 *
 * The server publishes the addresses it uses at /api/legal ("contact" from LEGAL_CONTACT, "business"
 * from BUSINESS_CONTACT, "security" from SECURITY_CONTACT), with these as its defaults. The pages show
 * these until it answers, and in the pages as built (what search engines and readers without scripts
 * get), the structured data and llms.txt.
 *
 * Plain data only: no React, no network, no build-time settings, so the node tests and the build
 * scripts can use it.
 */
export const SUPPORT_EMAIL = "support@visionswap.net";
export const BUSINESS_EMAIL = "business@visionswap.net";

/** "mailto:support@visionswap.net" */
export const mailto = (address: string) => `mailto:${address}`;
