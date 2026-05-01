import { google } from 'googleapis';

export const getSheetsClient = () => {
  try {
    const clientEmail = process.env['GOOGLE_SERVICE_ACCOUNT_EMAIL'];
    let privateKey = process.env['GOOGLE_PRIVATE_KEY'];

    if (!clientEmail || !privateKey) {
      console.warn("⚠️ Google Sheets credentials missing in environment");
      return null;
    }

    privateKey = privateKey.trim();

    if ((privateKey.startsWith('"') && privateKey.endsWith('"')) ||
        (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
      privateKey = privateKey.substring(1, privateKey.length - 1);
    }

    privateKey = privateKey.replace(/\\n/g, '\n');

    if (!privateKey.includes("BEGIN PRIVATE KEY")) {
      console.warn("⚠️ GOOGLE_PRIVATE_KEY is invalid — missing PEM header.");
      return null;
    }

    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    return google.sheets({ version: 'v4', auth });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error("Sheets Init Error:", e.message);
    return null;
  }
};
