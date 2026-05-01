import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import intelRouter from "./intel.js";
import orbatRouter from "./orbat.js";
import systemRouter from "./system.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(intelRouter);
router.use(orbatRouter);
router.use(systemRouter);

export default router;
