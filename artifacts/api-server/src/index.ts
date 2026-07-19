import cron from "node-cron";
import app from "./app";
import { logger } from "./lib/logger";
import { syncAllUsers } from "./services/plaid-sync";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Nightly Plaid transaction sync at 2:00 AM.
cron.schedule("0 2 * * *", () => {
  logger.info("Starting nightly Plaid transaction sync");
  void syncAllUsers()
    .then(() => logger.info("Nightly Plaid sync complete"))
    .catch((err) => logger.error({ err }, "Nightly Plaid sync error"));
});
