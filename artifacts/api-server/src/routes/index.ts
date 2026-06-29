import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import billsRouter from "./bills";
import paySchedulesRouter from "./pay_schedules";
import accountsRouter from "./accounts";
import assetsRouter from "./assets";
import forecastRouter from "./forecast";
import userSettingsRouter from "./user_settings";
import anthropicRouter from "./anthropic/index";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireAuth);
router.use(dashboardRouter);
router.use(billsRouter);
router.use(paySchedulesRouter);
router.use(accountsRouter);
router.use(assetsRouter);
router.use(forecastRouter);
router.use(userSettingsRouter);
router.use(anthropicRouter);

export default router;
