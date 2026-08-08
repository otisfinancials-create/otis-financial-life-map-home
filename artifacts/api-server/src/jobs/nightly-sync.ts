/**
 * Standalone run-to-completion entry for the nightly Plaid sync.
 *
 * Intended for a Scheduled Deployment (or any external scheduler): it runs
 * syncAllUsers() once and exits non-zero only on total failure, so a
 * scheduler can alert on it. Per-item failures are recorded on plaid_items
 * (last_sync_error / consecutive_failures) and never abort the run — and
 * because /transactions/sync is cursor-based, the next successful run picks
 * up everything missed, so a failed night self-heals.
 *
 * Run: node --enable-source-maps artifacts/api-server/dist/jobs/nightly-sync.mjs
 * Dev: tsx src/jobs/nightly-sync.ts
 */
import { logger } from "../lib/logger";
import { syncAllUsers } from "../services/plaid-sync";

async function main(): Promise<void> {
  logger.info("Scheduled nightly Plaid sync starting");
  await syncAllUsers();
  logger.info("Scheduled nightly Plaid sync complete");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Scheduled nightly Plaid sync failed");
    process.exit(1);
  });
