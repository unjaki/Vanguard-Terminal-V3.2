import { Router } from 'express';
import mongoose from 'mongoose';

const router = Router();

router.get('/system/status', (_req, res) => {
  res.json({
    database: mongoose.connection.readyState === 1 ? "ONLINE" : "OFFLINE",
    uptime: process.uptime(),
    env: process.env['NODE_ENV'] || "development"
  });
});

export default router;
