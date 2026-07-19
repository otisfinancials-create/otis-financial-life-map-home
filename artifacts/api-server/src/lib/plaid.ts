import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

const env = process.env.PLAID_ENV ?? "sandbox";
const basePath = PlaidEnvironments[env];
if (!basePath) {
  throw new Error(`Invalid PLAID_ENV: ${env}`);
}
if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
  throw new Error("PLAID_CLIENT_ID and PLAID_SECRET must be set");
}

const configuration = new Configuration({
  basePath,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

export const plaidClient = new PlaidApi(configuration);

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
