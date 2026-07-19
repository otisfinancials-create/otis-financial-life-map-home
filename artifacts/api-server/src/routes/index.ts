import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import healthRouter from "./health";
import subscribeRouter from "./subscribe";
import dashboardRouter from "./dashboard";
import billsRouter from "./bills";
import lifeEventsRouter from "./life_events";
import paySchedulesRouter from "./pay_schedules";
import accountsRouter from "./accounts";
import assetsRouter from "./assets";
import loansRouter from "./loans";
import forecastRouter from "./forecast";
import userSettingsRouter from "./user_settings";
import retirementRouter from "./retirement";
import otisRouter from "./otis";
import scenariosRouter from "./scenarios";
import plaidRouter from "./plaid";
import plaidWebhookRouter from "./plaid_webhook";
import { invalidateOtisCache } from "../lib/otis-cache";

const router: IRouter = Router();

/** Invalidate Otis cached answers whenever financial data changes. */
const otisCacheInvalidation: import("express").RequestHandler = (req, res, next) => {
  if (req.method !== "GET" && /^\/(accounts|assets|loans|bills|pay-schedules|settings|forecast|plaid)/.test(req.path)) {
    res.on("finish", () => {
      if (res.statusCode < 400 && req.userId) {
        void invalidateOtisCache(req.userId, ["net_worth", "cash_flow"]).catch(() => {});
      }
    });
  }
  next();
};

router.use(healthRouter);
router.use(subscribeRouter);
router.use(plaidWebhookRouter);
router.use(requireAuth);
router.use(otisCacheInvalidation);
router.use(dashboardRouter);
router.use(billsRouter);
router.use(lifeEventsRouter);
router.use(paySchedulesRouter);
router.use(accountsRouter);
router.use(assetsRouter);
router.use(loansRouter);
router.use(forecastRouter);
router.use(userSettingsRouter);
router.use(retirementRouter);
router.use(otisRouter);
router.use(scenariosRouter);
router.use(plaidRouter);

export default router;
