import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

const env = process.env.PLAID_ENV ?? "sandbox";
const basePath = PlaidEnvironments[env];
if (!basePath) {
  throw new Error(`Invalid PLAID_ENV: ${env}`);
}
// Plaid secrets are per-environment: when pointed at sandbox, use the
// dedicated sandbox secret (never the live PLAID_SECRET).
const plaidSecret = env === "sandbox" ? process.env.PLAID_SANDBOX_SECRET : process.env.PLAID_SECRET;
if (!process.env.PLAID_CLIENT_ID || !plaidSecret) {
  throw new Error(`PLAID_CLIENT_ID and ${env === "sandbox" ? "PLAID_SANDBOX_SECRET" : "PLAID_SECRET"} must be set`);
}

const configuration = new Configuration({
  basePath,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": plaidSecret,
    },
  },
});

export const plaidClient = new PlaidApi(configuration);

/**
 * Sanitize a Plaid-provided display name before persisting it.
 *
 * Plaid sometimes transmits U+FFFD replacement characters where the source
 * institution's encoding was mangled upstream (verified on the wire: e.g.
 * Wells Fargo "WAY2SAVE® SAVINGS" arrives as "WAY2SAVE\uFFFD\uFFFD SAVINGS").
 * The original bytes are unrecoverable by the time they reach us, and U+FFFD
 * carries no information — strip it at ingest and collapse the leftover
 * whitespace rather than storing garbage.
 */
export function cleanPlaidName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const cleaned = name.replace(/\uFFFD+/g, "").replace(/\s{2,}/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Map a Plaid account (type, subtype) to an Otis account type. */
export function mapPlaidAccountType(type: string, subtype: string | null): { accountType: string; isAsset: boolean } {
  const t = type.toLowerCase();
  const s = (subtype ?? "").toLowerCase();
  if (t === "depository") {
    if (s === "savings") return { accountType: "savings", isAsset: true };
    return { accountType: "checking", isAsset: true };
  }
  if (t === "credit") return { accountType: "credit_card", isAsset: false };
  if (t === "investment" || t === "brokerage") return { accountType: "investment", isAsset: true };
  if (t === "loan") {
    if (s === "mortgage") return { accountType: "mortgage", isAsset: false };
    return { accountType: "loan", isAsset: false };
  }
  return { accountType: "other", isAsset: true };
}
