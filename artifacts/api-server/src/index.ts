import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import app from "./app.js";
import { logger } from "./lib/logger.js";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

// MongoDB Connection
const mongoUrl = process.env["MONGO_URL"];
if (!mongoUrl) {
  logger.warn("⚠️ MONGO_URL not set — database features disabled. Set MONGO_URL in Secrets to enable.");
} else {
  logger.info("📡 Connecting to MongoDB...");
  mongoose.connect(mongoUrl)
    .then(async () => {
      logger.info("✅ MongoDB connected");

      // Bootstrap default admin if DB is empty
      try {
        const { User } = await import('./models/User.js');
        const count = await User.countDocuments();
        if (count === 0) {
          logger.info("🚀 Bootstrapping default CBRN_Admin account...");
          const hashedPassword = await bcrypt.hash("CBRN123", 10);
          await User.create({ username: "CBRN_Admin", password: hashedPassword, tier: 5, unitScope: "CBRN" });
          logger.info("✅ Default account created: CBRN_Admin / CBRN123");
        }
      } catch (bootErr: unknown) {
        logger.error({ err: bootErr }, "Bootstrap error");
      }
    })
    .catch((err: unknown) => {
      logger.error({ err }, "❌ MongoDB connection failed. Check MONGO_URL and Atlas IP whitelist (0.0.0.0/0).");
    });
}

app.listen(port, (err) => {
  if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }
  logger.info({ port }, "GSMC Vanguard Terminal active");
});
