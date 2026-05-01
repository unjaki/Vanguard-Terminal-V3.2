import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { User } from '../models/User.js';
import { protectTier } from '../middlewares/auth.js';

const router = Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body as { username: string; password: string };
    console.log(`[AUTH] Login attempt for: ${username}`);

    const userData = await User.findOne({ username });
    if (!userData) {
      console.warn(`[AUTH] User not found: ${username}`);
      res.status(400).json({ message: "User not found" });
      return;
    }

    const isMatch = await bcrypt.compare(password, userData.password);
    if (!isMatch) {
      console.warn(`[AUTH] Invalid credentials for: ${username}`);
      res.status(400).json({ message: "Invalid credentials" });
      return;
    }

    const secret = process.env['JWT_SECRET'];
    if (!secret) { res.status(500).json({ message: "Server misconfiguration." }); return; }

    const token = jwt.sign(
      { id: userData._id, username: userData.username, tier: userData.tier, scope: userData.unitScope },
      secret,
      { expiresIn: '8h' }
    );

    if (process.env['DISCORD_WEBHOOK_URL']) {
      try {
        await axios.post(process.env['DISCORD_WEBHOOK_URL'], {
          embeds: [{
            title: "GSMC System Access",
            description: `**Officer:** ${username}\n**Access Tier:** ${userData.tier}\n**Scope:** ${userData.unitScope}`,
            color: userData.tier === 5 ? 15158332 : 3447003,
            timestamp: new Date()
          }]
        });
      } catch { console.error("Webhook Failed"); }
    }

    res.json({ message: `Welcome back, ${username}`, token, tier: userData.tier, unitScope: userData.unitScope });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(500).json({ error: e.message });
  }
});

router.post('/register', protectTier(5), async (req, res) => {
  try {
    const { username, password, tier, division, unitScope } = req.body as {
      username: string; password: string; tier: number; division: string; unitScope: string;
    };
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const newUser = new User({ username, password: hashedPassword, tier, division, unitScope });
    await newUser.save();
    res.status(201).json({ message: "Secure user created." });
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(500).json({ error: e.message });
  }
});

router.get('/auth/verify', protectTier(2), (req, res) => {
  res.json({ success: true, tier: req.user?.tier, unitScope: req.user?.scope });
});

export default router;
