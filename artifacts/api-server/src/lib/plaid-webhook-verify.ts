import { createHash } from "node:crypto";
import { importJWK, jwtVerify, decodeProtectedHeader, type JWK } from "jose";
import { plaidClient } from "./plaid";

const keyCache = new Map<string, JWK>();

/**
 * Verify a Plaid webhook per Plaid's spec:
 * - `Plaid-Verification` header is a JWT signed ES256 with a key fetched from
 *   /webhook_verification_key/get (looked up by the JWT's kid).
 * - The JWT payload's request_body_sha256 must match the raw request body.
 * - Reject JWTs issued more than 5 minutes ago.
 */
export async function verifyPlaidWebhook(jwtToken: string | undefined, rawBody: Buffer | undefined): Promise<boolean> {
  if (!jwtToken || !rawBody) return false;
  try {
    const header = decodeProtectedHeader(jwtToken);
    if (header.alg !== "ES256" || typeof header.kid !== "string") return false;

    let jwk = keyCache.get(header.kid);
    if (!jwk) {
      const resp = await plaidClient.webhookVerificationKeyGet({ key_id: header.kid });
      jwk = resp.data.key as unknown as JWK;
      keyCache.set(header.kid, jwk);
    }

    const key = await importJWK(jwk, "ES256");
    const { payload } = await jwtVerify(jwtToken, key, { maxTokenAge: "5 minutes" });

    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    return payload["request_body_sha256"] === bodyHash;
  } catch {
    return false;
  }
}
