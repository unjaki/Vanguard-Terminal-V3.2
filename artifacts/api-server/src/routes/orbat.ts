import { Router } from 'express';
import { protectTier } from '../middlewares/auth.js';
import { getSheetsClient } from '../lib/sheets.js';
import { logAction } from '../lib/audit.js';

const router = Router();

router.post('/sync-to-orbat', protectTier(3), async (req, res) => {
  try {
    const { officer, robloxId, discordId, unitId, rank, nsRank } = req.body as {
      officer: string; robloxId: string; discordId?: string;
      unitId: string; rank?: string; nsRank?: string;
    };

    const sheets = getSheetsClient();
    if (!sheets) {
      res.status(500).json({ message: "ORBAT Uplink Offline (Auth Error)" });
      return;
    }

    let rawId: string | undefined;
    if (unitId === "288142915") rawId = process.env['GOOGLE_SHEET_ID_GSMC'];
    else if (unitId === "423217030") rawId = process.env['GOOGLE_SHEET_ID_CBRN'];
    else if (unitId === "1008942731") rawId = process.env['GOOGLE_SHEET_ID_NS'];

    const spreadsheetId = rawId?.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] || rawId?.trim();

    if (!spreadsheetId) {
      res.status(400).json({ message: "Target ORBAT Not Configured" });
      return;
    }

    const values = [[
      officer,
      String(robloxId),
      String(discordId || "N/A"),
      String(rank || "—"),
      String(nsRank || "—")
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'ORBAT!A:E',
      valueInputOption: 'RAW',
      requestBody: { values }
    });

    logAction(req.user!, "ORBAT_SYNC", `**Officer:** ${officer}\n**Target Unit:** ${unitId}\n**Sheet ID:** ${spreadsheetId.substring(0, 15)}...`, 15158332);
    res.json({ success: true, message: "Uplink Successful" });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error("ORBAT Sync Error:", e.message);
    res.status(500).json({ error: "Sync Failed", details: e.message });
  }
});

export default router;
