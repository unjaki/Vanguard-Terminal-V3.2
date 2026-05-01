import axios from 'axios';

interface AuditUser {
  username?: string;
  id?: string;
  scope?: string;
}

export const logAction = async (user: AuditUser, action: string, details: string, color = 3447003) => {
  try {
    if (!process.env['DISCORD_WEBHOOK_URL']) return;

    const operative = user?.username ? user.username : (user?.id ? `ID: ${user.id}` : "Unknown System");
    const scope = user?.scope ?? "N/A";

    await axios.post(process.env['DISCORD_WEBHOOK_URL'], {
      embeds: [{
        title: "VANGUARD AUDIT LOG",
        fields: [
          { name: "OPERATIVE", value: `**${operative}**`, inline: true },
          { name: "UNIT_SCOPE", value: scope, inline: true },
          { name: "ACTION", value: `\`${action}\``, inline: true },
          { name: "DETAILS", value: details }
        ],
        color,
        timestamp: new Date(),
        footer: { text: "GSMC Operational Intelligence | Audit Protocol" }
      }]
    });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error("Audit Log Failed:", e.message);
  }
};
