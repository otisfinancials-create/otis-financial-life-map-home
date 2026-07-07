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
import anthropicRouter from "./anthropic/index";

const router: IRouter = Router();

router.use(healthRouter);
router.use(subscribeRouter);
router.use(requireAuth);
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
router.use(anthropicRouter);

export default router;
