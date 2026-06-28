import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import billsRouter from "./bills";
import paySchedulesRouter from "./pay_schedules";
import accountsRouter from "./accounts";
import forecastRouter from "./forecast";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(billsRouter);
router.use(paySchedulesRouter);
router.use(accountsRouter);
router.use(forecastRouter);

export default router;
