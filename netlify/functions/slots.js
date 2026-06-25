// GET /api/slots  (mapped to this function via netlify.toml redirect)
//
// Returns the list of bookable trial-lesson slots for the form.
// Reads availability from Calendly and current booking counts from the Google
// Apps Script web app, then hides:
//   - slots in the past
//   - slots that fall on today's date (America/New_York) — managers need lead time
//   - slots that already have 3 or more bookings
//
// All credentials stay server-side (Netlify env vars). The browser only ever
// sees the filtered result.

const CALENDLY_BASE = "https://api.calendly.com";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Calendly limits a single availability request to a 7-day window. Scan a few
// weeks ahead and merge the results so lessons scheduled further out still show.
const WEEKS_AHEAD = 4;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function nyDateString(date) {
  // YYYY-MM-DD for the given instant in New York time.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(date);
}

function formatLabel(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  let hour = get("hour");
  if (hour === "24") hour = "00"; // hour12:false can emit "24" at midnight
  return `${get("weekday")}, ${get("month")} ${get("day")} · ${hour}:${get("minute")} EST`;
}

async function fetchCalendlyWindow(eventTypeUri, token, startISO, endISO) {
  const collected = [];
  let url =
    `${CALENDLY_BASE}/event_type_available_times` +
    `?event_type=${encodeURIComponent(eventTypeUri)}` +
    `&start_time=${encodeURIComponent(startISO)}` +
    `&end_time=${encodeURIComponent(endISO)}`;
  // Follow pagination if Calendly returns it.
  for (let guard = 0; guard < 10 && url; guard++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Calendly ${res.status}: ${text}`);
    }
    const data = await res.json();
    for (const item of data.collection || []) {
      if (item.status === "available" && item.start_time) collected.push(item.start_time);
    }
    url = data.pagination && data.pagination.next_page ? data.pagination.next_page : null;
  }
  return collected;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const token = process.env.CALENDLY_ACCESS_TOKEN;
  const eventTypeUri = process.env.CALENDLY_EVENT_TYPE_URI;
  const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
  if (!token || !eventTypeUri || !scriptUrl) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Server is not configured" }) };
  }

  try {
    const now = new Date();

    // 1. Pull availability from Calendly across several 7-day windows in parallel.
    const windowRequests = [];
    for (let i = 0; i < WEEKS_AHEAD; i++) {
      // Nudge the first window a minute into the future so Calendly accepts it.
      const start = new Date(now.getTime() + i * 7 * MS_PER_DAY + (i === 0 ? 60 * 1000 : 0));
      const end = new Date(start.getTime() + 7 * MS_PER_DAY - 1000);
      windowRequests.push(fetchCalendlyWindow(eventTypeUri, token, start.toISOString(), end.toISOString()));
    }
    const windowResults = await Promise.all(windowRequests);
    const startTimes = Array.from(new Set(windowResults.flat()));

    // 2. Pull booking counts from Google Sheets. If this fails, fail open
    //    (show the slots) rather than blocking every booking.
    let counts = {};
    try {
      const countsRes = await fetch(`${scriptUrl}?action=counts`);
      if (countsRes.ok) {
        const countsData = await countsRes.json();
        counts = (countsData && countsData.counts) || {};
      }
    } catch (e) {
      counts = {};
    }

    // 3. Filter: future, not today (NY tz), fewer than 3 bookings.
    //    Slot times stay in Calendly's exact string form — booking counts are
    //    matched by string comparison, so the format must be preserved.
    const todayNY = nyDateString(now);
    const slots = startTimes
      .filter((startTime) => {
        const slotDate = new Date(startTime);
        if (!(slotDate > now)) return false;
        if (nyDateString(slotDate) <= todayNY) return false;
        if ((counts[startTime] || 0) >= 3) return false;
        return true;
      })
      .sort((a, b) => new Date(a) - new Date(b))
      .map((startTime) => ({ start: startTime, label: formatLabel(new Date(startTime)) }));

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ slots }) };
  } catch (err) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Could not load schedule" }) };
  }
};
