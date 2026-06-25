// POST /api/book
// Accepts the booking form data, writes the lead to Google Sheets and notifies
// the school managers on Telegram.
//
// The Google Sheets write is the source of truth: only after it succeeds does
// the endpoint return { success: true }. The Telegram notification is sent
// afterwards and never fails a confirmed booking — but it IS awaited, because a
// serverless function can be frozen the moment it responds, which would drop a
// true "fire-and-forget" notification. Awaiting keeps notifications reliable
// while still firing strictly after the lead is saved.

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegram(lead, slotLabel) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  // Internal notification for managers — Russian, not shown to users.
  const text =
    `<b>Новая заявка — Пробный урок</b>\n\n` +
    `Ребёнок: ${esc(lead.childName)}, ${esc(lead.grade)} класс\n` +
    `Компьютер дома: ${lead.hasComputer ? "Да" : "Нет"}\n` +
    `Родитель: ${esc(lead.parentName)}\n` +
    `Телефон: ${esc(lead.phone)}\n` +
    `Email: ${esc(lead.email)}\n` +
    `Выбранное время: ${esc(slotLabel)}`;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, parse_mode: "HTML", text }),
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
  if (!scriptUrl) return res.status(500).json({ success: false, error: "Server is not configured" });

  // Body may arrive already parsed (Vercel) or as a raw string.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // slotTime keeps Calendly's exact string so the sheet's per-slot counting,
  // which compares strings, stays consistent.
  const lead = {
    slotTime: body.slotTime,
    childName: body.childName,
    grade: body.grade,
    hasComputer: !!body.hasComputer,
    parentName: body.parentName,
    phone: body.phone,
    email: body.email,
  };

  // 1. Write the lead to Google Sheets — this must succeed.
  try {
    const sheetRes = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
    });
    if (!sheetRes.ok) {
      return res.status(502).json({ success: false, error: "Could not save booking" });
    }
  } catch (e) {
    return res.status(502).json({ success: false, error: "Could not save booking" });
  }

  // 2. Notify managers (best-effort — a Telegram outage must not fail a booking).
  try {
    await sendTelegram(lead, body.slotLabel);
  } catch (e) {
    // ignore — the booking is already saved
  }

  return res.status(200).json({ success: true });
};
