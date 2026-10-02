export async function notify(message) {
  const webhook = process.env.DISCORD_WEBHOOK_URL || "";
  if (!webhook) return;
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } })
  });
  if (!response.ok) throw new Error("Discord webhook " + response.status + ": " + await response.text());
}