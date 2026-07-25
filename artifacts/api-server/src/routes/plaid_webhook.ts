import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, plaidItemsTable } from "@workspace/db";
import { syncTransactionsForItem, sanitizeSyncError } from "../services/plaid-sync";
import { verifyPlaidWebhook } from "../lib/plaid-webhook-verify";

/**
 * Public Plaid webhook receiver (mounted before requireAuth).
 * Requests are authenticated by verifying the Plaid-Verification JWT signature
 * against Plaid's webhook verification keys — unsigned requests are rejected.
 * Responds 200 quickly; sync runs in the background with a per-item lock.
 */
const router: IRouter = Router();

const SYNC_CODES = new Set(["SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"]);
/** ITEM webhook codes that mean the user must re-authenticate the connection. */
const REAUTH_CODES = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT"]);

/** Per-item concurrency lock + debounce so webhook floods can't fan out sync loops. */
const inFlight = new Set<string>();
const lastRun = new Map<string, number>();
const DEBOUNCE_MS = 30_000;

router.post("/plaid/webhook", async (req, res): Promise<void> => {
  const rawBody = (req as { rawBody?: Buffer }).rawBody;
  const verified = await verifyPlaidWebhook(req.header("plaid-verification"), rawBody);
  if (!verified) {
    req.log.warn("Rejected Plaid webhook with missing/invalid signature");
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  const body = (req.body ?? {}) as { webhook_type?: string; webhook_code?: string; item_id?: string };
  req.log.info({ webhookType: body.webhook_type, webhookCode: body.webhook_code }, "Plaid webhook received");

  // ITEM lifecycle: flag items needing re-auth; clear the flag when repaired.
  if (body.webhook_type === "ITEM" && typeof body.item_id === "string") {
    const code = body.webhook_code ?? "";
    if (REAUTH_CODES.has(code) || code === "LOGIN_REPAIRED") {
      const needsReauth = code !== "LOGIN_REPAIRED";
      db.update(plaidItemsTable)
        .set({ needsReauth, updatedAt: new Date() })
        .where(eq(plaidItemsTable.itemId, body.item_id))
        .then(() => {
          req.log.info({ webhookCode: code, needsReauth }, "Updated Plaid item re-auth flag");
        })
        .catch((err) => {
          req.log.error({ err: sanitizeSyncError(err) }, "Failed to update Plaid item re-auth flag");
        });
    }
  }

  if (body.webhook_type === "TRANSACTIONS" && SYNC_CODES.has(body.webhook_code ?? "") && typeof body.item_id === "string") {
    const itemId = body.item_id;
    const now = Date.now();
    if (!inFlight.has(itemId) && now - (lastRun.get(itemId) ?? 0) >= DEBOUNCE_MS) {
      inFlight.add(itemId);
      lastRun.set(itemId, now);
      void (async () => {
        const [item] = await db.select().from(plaidItemsTable).where(eq(plaidItemsTable.itemId, itemId));
        if (item) {
          await syncTransactionsForItem(item);
        }
      })()
        .catch((err) => {
          req.log.error({ err: sanitizeSyncError(err) }, "Webhook-triggered Plaid sync failed");
        })
        .finally(() => {
          inFlight.delete(itemId);
        });
    }
  }

  res.json({ received: true });
});

export default router;
