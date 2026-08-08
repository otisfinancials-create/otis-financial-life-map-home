/**
 * One-shot maintenance job: point every Plaid item's webhook at a new URL.
 *
 * Existing items keep the webhook URL registered at link time — changing the
 * link-token config only affects FUTURE links. After publishing (or any
 * domain change), run this against the production URL so live items stop
 * firing at a dead endpoint.
 *
 * Usage: tsx src/jobs/update-webhooks.ts https://<prod-domain>/api/plaid/webhook
 * Prints each item's webhook as verified via /item/get afterwards.
 */
import { db, plaidItemsTable } from "@workspace/db";
import { plaidClient } from "../lib/plaid";

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url || !/^https:\/\//.test(url)) {
    console.error("Usage: tsx src/jobs/update-webhooks.ts https://<domain>/api/plaid/webhook");
    process.exit(1);
  }
  const items = await db.select().from(plaidItemsTable);
  for (const item of items) {
    await plaidClient.itemWebhookUpdate({ access_token: item.accessToken, webhook: url });
    const { data } = await plaidClient.itemGet({ access_token: item.accessToken });
    console.log(`item ${item.id} (${item.institutionName}): webhook = ${data.item.webhook}`);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
