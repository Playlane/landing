// api/rsvp.js
// Vercel serverless function for the private Rye Lane screening RSVP (playlane.co/rsvp).
//
//   GET  /api/rsvp  → how many places are left, so the page can show "x spots left" or "full"
//   POST /api/rsvp  → saves the RSVP to Airtable, sends the confirmation email (with the address),
//                     and, if the guest ticked "become a host", adds them to the Hosts table
//                     and sends the normal host welcome email too.
//
// Uses the same Vercel environment variables as the host sign-up:
//   AIRTABLE_PERSONAL_ACCESS_TOKEN, RESEND_API_KEY, WHATSAPP_HOST_GROUP_URL
// The RSVP table lives in the same base as the Hosts table.

import {
  EMAIL_SUBJECT as HOST_EMAIL_SUBJECT,
  getEmailHTML as getHostEmailHTML,
  getEmailText as getHostEmailText,
} from "./waitlist.js";

// ─── The event. Change these for the next screening. ─────────────────────
const EVENT = {
  capacity: 30,
  film: "Rye Lane",
  when: "Saturday 31 October 2026, 6PM",
  venue: "Cortland Broad Street",
  address: "Broad Street, Birmingham",
};
const MAPS_URL =
  "https://www.google.com/maps/search/?api=1&query=" +
  encodeURIComponent(`${EVENT.venue}, ${EVENT.address}`);

// ─── Airtable ────────────────────────────────────────────────────────────
// Same base as the Hosts table. The RSVP table needs these fields:
//   Name (Single line text), Email (Email or Single line text), Phone (Single line text),
//   Needs (Long text), Wants to host (Checkbox), Host status (Single line text)
const AIRTABLE_BASE_ID = "app3DdTXYXOPuzs0V";
const HOSTS_TABLE = "tblqrXUZZcZaStDZO"; // the "Hosts" table (Name, Email, Phone, City, Country)
const RSVP_BASE_ID = AIRTABLE_BASE_ID; // same base as Hosts
const RSVP_TABLE = "RSVP"; // the table's name in Airtable
const AIRTABLE_API = process.env.AIRTABLE_API_URL || "https://api.airtable.com"; // overridable for testing
const RESEND_API = process.env.RESEND_API_URL || "https://api.resend.com";

const SAVE_FAILED_MESSAGE =
  "We couldn't save your RSVP because of a problem on our side, not with what you typed. " +
  "Please try again in a few minutes, or email helloneighbour@playlane.co and we'll save you a spot.";
const FULL_MESSAGE =
  "Sorry, all 30 spots for Rye Lane have gone. Keep an eye out for the next PlayLane screening.";

// Error codes shown to the guest as "Error code: …". Full details are in Vercel → Logs.
//   RSVP_AUTH        Airtable token missing or invalid (AIRTABLE_PERSONAL_ACCESS_TOKEN).
//   RSVP_TABLE       RSVP or Hosts table not found, or the token has no access to its base.
//   RSVP_FIELD       A field name doesn't match. Expected: Name, Email, Phone, Needs, Wants to host, Host status.
//   RSVP_FIELD_TYPE  A field has the wrong type ("Wants to host" must be a Checkbox).
//   RSVP_BUSY        Airtable rate limit. Fixes itself within a minute.
//   RSVP_ERROR       Any other Airtable problem.
//   SERVER_ERROR     Unexpected crash in this function.
function describeAirtableError(status, body) {
  const type = (body && body.error && body.error.type) || (body && typeof body.error === "string" && body.error) || "";
  if (status === 401 || type === "AUTHENTICATION_REQUIRED") return { code: "RSVP_AUTH", hint: "Airtable token missing or invalid." };
  if (status === 403 || status === 404 || /NOT_FOUND|PERMISSIONS/.test(type)) {
    return { code: "RSVP_TABLE", hint: `RSVP table (${RSVP_BASE_ID}/${RSVP_TABLE}) or Hosts table (${AIRTABLE_BASE_ID}/${HOSTS_TABLE}) not found, or the Airtable token has no access to that base.` };
  }
  if (type === "UNKNOWN_FIELD_NAME" || type === "INVALID_FILTER_BY_FORMULA") {
    return { code: "RSVP_FIELD", hint: "A field name doesn't match Airtable. Expected: Name, Email, Phone, Needs, Wants to host, Host status." };
  }
  if (/INVALID_VALUE_FOR_COLUMN|INVALID_MULTIPLE_CHOICE|INVALID_REQUEST_UNKNOWN/.test(type)) {
    return { code: "RSVP_FIELD_TYPE", hint: 'A field has the wrong type. "Wants to host" must be a Checkbox; the rest text.' };
  }
  if (status === 429) return { code: "RSVP_BUSY", hint: "Airtable rate limit hit." };
  return { code: "RSVP_ERROR", hint: `Unexpected Airtable response (HTTP ${status}${type ? ", " + type : ""}).` };
}

class AirtableError extends Error {
  constructor(problem, where, body) {
    super(`${problem.code} (${where}): ${problem.hint}`);
    this.problem = problem;
    this.body = body;
  }
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

function tableUrl(table, base = AIRTABLE_BASE_ID) {
  return `${AIRTABLE_API}/v0/${base}/${encodeURIComponent(table)}`;
}

async function airtable(url, where, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await readJson(res);
  if (!res.ok) throw new AirtableError(describeAirtableError(res.status, data), where, data);
  return data || {};
}

// Every RSVP so far (just Email). Handles Airtable's 100-per-page limit.
async function listRsvps() {
  const records = [];
  let offset = "";
  do {
    const url = `${tableUrl(RSVP_TABLE, RSVP_BASE_ID)}?pageSize=100&fields%5B%5D=Email${offset ? "&offset=" + encodeURIComponent(offset) : ""}`;
    const data = await airtable(url, "reading RSVPs");
    // Only rows with an email count as RSVPs, so blank rows never use up a spot
    records.push(...(data.records || []).filter(r => String((r.fields && r.fields.Email) || "").trim()));
    offset = data.offset || "";
  } while (offset);
  return records;
}

// ─── Matching (same rules as the host sign-up) ───────────────────────────
function formulaString(text) {
  return '"' + String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
const PHONE_MATCH_DIGITS = 9;
function phoneDigitsOf(text) { return String(text || "").replace(/\D/g, ""); }

async function isExistingHost(email, phone) {
  const digits = phoneDigitsOf(phone);
  const phoneInAirtable = `REGEX_REPLACE({Phone} & "", "[^0-9]", "")`;
  const formula =
    `OR(` +
      `LOWER(TRIM({Email} & "")) = ${formulaString(email.toLowerCase())}, ` +
      `${phoneInAirtable} = ${formulaString(digits)}, ` +
      `AND(LEN(${phoneInAirtable}) >= ${PHONE_MATCH_DIGITS}, RIGHT(${phoneInAirtable}, ${PHONE_MATCH_DIGITS}) = ${formulaString(digits.slice(-PHONE_MATCH_DIGITS))})` +
    `)`;
  const url = `${tableUrl(HOSTS_TABLE)}?maxRecords=1&fields%5B%5D=Email&filterByFormula=${encodeURIComponent(formula)}`;
  const data = await airtable(url, "checking Hosts");
  return (data.records || []).length > 0;
}

async function sendEmail(payload, label) {
  try {
    const res = await fetch(`${RESEND_API}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "PlayLane <helloneighbour@playlane.co>", ...payload }), // payload.from overrides the sender
    });
    if (!res.ok) console.error(`[rsvp] EMAIL_FAILED (${label}):`, JSON.stringify(await readJson(res)));
    return res.ok;
  } catch (err) {
    console.error(`[rsvp] EMAIL_FAILED (${label}):`, err);
    return false;
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (!process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN) {
    console.error("[rsvp] RSVP_AUTH: AIRTABLE_PERSONAL_ACCESS_TOKEN is not set in Vercel.");
    return res.status(500).json({ error: "save_failed", code: "RSVP_AUTH", message: SAVE_FAILED_MESSAGE });
  }

  // ── GET: places left ──────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const taken = (await listRsvps()).length;
      const spotsLeft = Math.max(0, EVENT.capacity - taken);
      return res.status(200).json({ capacity: EVENT.capacity, spotsLeft, full: spotsLeft === 0 });
    } catch (err) {
      console.error("[rsvp] spots check failed:", err.message || err, JSON.stringify(err.body || ""));
      return res.status(500).json({ error: "unavailable" });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed", message: "Method not allowed." });
  }

  try {
    const body = req.body || {};
    const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const name = str(body.name, 100);
    const email = str(body.email, 200);
    const phone = str(body.phone, 20);
    const needs = str(body.needs, 500);
    const wantsToHost = body.wantsToHost === true;
    const hostCity = str(body.hostCity, 80);

    const invalid = (field, message) => res.status(400).json({ error: "invalid", field, message });
    if (!name) return invalid("name", "Please enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return invalid("email", "Please enter a valid email address, like name@example.com.");
    const phoneDigits = phoneDigitsOf(phone).length;
    if (!/^\+?[\d\s().-]+$/.test(phone) || phoneDigits < 7 || phoneDigits > 15) {
      return invalid("phone", "Please enter a valid WhatsApp number with your country code, like +44 7700 900123.");
    }
    if (wantsToHost && !hostCity) return invalid("hostCity", "Please tell us the city or town you'd host in.");

    // ── Already RSVP'd? Full? ─────────────────────────────────────
    const rsvps = await listRsvps();
    const already = rsvps.some(r => String((r.fields && r.fields.Email) || "").trim().toLowerCase() === email.toLowerCase());
    if (already) {
      return res.status(409).json({
        error: "duplicate",
        field: "email",
        message: "You already have a spot. Check your inbox (and spam) for your confirmation with the address. Bringing someone? They need to RSVP with their own email.",
      });
    }
    if (rsvps.length >= EVENT.capacity) {
      return res.status(410).json({ error: "full", message: FULL_MESSAGE });
    }

    // ── Hosting (never blocks the RSVP if it goes wrong) ──────────
    // hostStatus: "" (didn't tick), "New host", "Already a host", "Host sign-up failed"
    let hostStatus = "";
    if (wantsToHost) {
      try {
        if (await isExistingHost(email, phone)) {
          hostStatus = "Already a host";
        } else {
          await airtable(tableUrl(HOSTS_TABLE), "adding host", {
            method: "POST",
            body: JSON.stringify({ records: [{ fields: { Name: name, Email: email, Phone: phone, City: hostCity, Country: "United Kingdom" } }] }),
          });
          hostStatus = "New host";
        }
      } catch (err) {
        console.error("[rsvp] Host sign-up failed (RSVP still saved):", err.message || err, JSON.stringify(err.body || ""));
        hostStatus = "Host sign-up failed";
      }
    }

    // ── Save the RSVP ─────────────────────────────────────────────
    await airtable(tableUrl(RSVP_TABLE, RSVP_BASE_ID), "saving RSVP", {
      method: "POST",
      body: JSON.stringify({
        records: [{
          fields: {
            Name: name,
            Email: email,
            Phone: phone,
            ...(needs ? { Needs: needs } : {}),
            "Wants to host": wantsToHost,
            ...(hostStatus ? { "Host status": hostStatus } : {}),
          },
        }],
      }),
    });

    // ── Emails ────────────────────────────────────────────────────
    const firstName = name.split(/\s+/)[0].slice(0, 40);
    await sendEmail({
      from: RSVP_EMAIL_FROM,
      to: [email],
      subject: RSVP_EMAIL_SUBJECT,
      html: (SIMPLE_EMAIL ? getRsvpEmailHTMLSimple : getRsvpEmailHTML)(escapeHtml(firstName), hostStatus),
      text: getRsvpEmailText(firstName, hostStatus),
    }, "RSVP confirmation");

    const whatsappUrl = process.env.WHATSAPP_HOST_GROUP_URL || "";
    if (hostStatus === "New host") {
      await sendEmail({
        to: [email],
        subject: HOST_EMAIL_SUBJECT,
        html: getHostEmailHTML(escapeHtml(firstName), whatsappUrl),
        text: getHostEmailText(firstName, whatsappUrl),
      }, "host welcome");
    }

    console.log(`[rsvp] Saved RSVP ${rsvps.length + 1}/${EVENT.capacity}${hostStatus ? " (" + hostStatus + ")" : ""}.`);
    return res.status(200).json({
      success: true,
      hostStatus,
      whatsappUrl: hostStatus === "New host" ? whatsappUrl : "",
      spotsLeft: Math.max(0, EVENT.capacity - rsvps.length - 1),
    });
  } catch (err) {
    if (err instanceof AirtableError) {
      console.error(`[rsvp] ${err.message}`, JSON.stringify(err.body));
      const busy = err.problem.code === "RSVP_BUSY";
      return res.status(busy ? 503 : 500).json({
        error: "save_failed",
        code: err.problem.code,
        message: busy ? "Lots of people are RSVPing right now. Please wait a minute and try again." : SAVE_FAILED_MESSAGE,
      });
    }
    console.error("[rsvp] SERVER_ERROR:", err);
    return res.status(500).json({ error: "server_error", code: "SERVER_ERROR", message: SAVE_FAILED_MESSAGE });
  }
}

// ─── RSVP confirmation email ─────────────────────────────────────────────

const RSVP_EMAIL_FROM = "Koko at PlayLane <helloneighbour@playlane.co>";
const RSVP_EMAIL_SUBJECT = "Look who’s joining Koko’s WatchLane";
// true = the plain, letter-style email (more likely to land in Gmail's Primary tab)
// false = the designed email with the poster
const SIMPLE_EMAIL = false;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function postscript(hostStatus) {
  if (hostStatus === "New host") {
    return "P.S. You also signed up to become a PlayLane Host. Look out for a separate email with the link to the Hosts’ WhatsApp group.";
  }
  if (hostStatus === "Already a host") {
    return "P.S. Good to have one of our Hosts in the room. Consider this one research.";
  }
  return "P.S. Ever imagined hosting a night like this? PlayLane Hosts bring screenings to their own communities, and they can earn from them too.";
}

function getRsvpEmailText(firstName, hostStatus) {
  return [
    `Hi ${firstName},`,
    "",
    "Look who’s joining Koko’s WatchLane. 👀",
    "",
    "Your RSVP is confirmed. We’ve saved you a spot on the Lane.",
    "",
    "Good cinema, good food, music and an interesting mix of people. We’re making a night of it, and you’re part of the plan.",
    "",
    "THE FILM: RYE LANE 🎬",
    "",
    "A film by Raine Allen-Miller, starring David Jonsson and Vivian Oparah.",
    "A little romance. A little chaos. A lot of South London.",
    "",
    "BEFORE YOU STEP ON THE LANE…",
    "",
    `📅 WHEN: ${EVENT.when}`,
    `📍 WHERE: ${EVENT.venue}, ${EVENT.address}`,
    `   Map: ${MAPS_URL}`,
    "✨ DRESS CODE: Relaxed with spark. Pyjamas and heels? We see the vision. PlayLane is an occasion, after all.",
    "ACCESSORIES: Your throw blanket.",
    "👯 PLUS ONES: Bringing someone? Love that. Just make sure they RSVP separately. Spaces are limited, and every guest needs a confirmed spot.",
    "",
    "⸻",
    "",
    "That’s the housekeeping sorted.",
    "",
    "Come curious. Come ready to meet someone interesting. And don’t make too many plans for afterwards.",
    "",
    "Any questions? Just reply to this email.",
    "",
    "See you on the Lane,",
    "Koko",
    "",
    postscript(hostStatus),
    ...(hostStatus ? [] : ["Become a Host: https://playlane.co/#host"]),
  ].join("\n");
}

function getRsvpEmailHTML(firstName, hostStatus) {
  const Y = "#fff69a", R = "#f4553a", INK = "#151412";
  const serif = "Georgia,'Times New Roman',serif";
  const mono = "'Courier New',monospace";
  const row = (label, value) =>
    `<tr><td style="padding:16px 0;border-top:1px solid ${INK};vertical-align:top;width:132px;font-family:${mono};font-size:12px;font-weight:bold;letter-spacing:1.5px;color:${INK}">${label}</td>` +
    `<td style="padding:16px 0;border-top:1px solid ${INK};vertical-align:top;font-family:${serif};font-size:17px;line-height:1.5;color:${INK}">${value}</td></tr>`;
  const hostButton = hostStatus ? "" :
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr><td style="background:${Y};padding:15px 20px"><a href="https://playlane.co/#host" target="_blank" style="font-family:${mono};font-size:14px;font-weight:bold;letter-spacing:1px;color:${INK};text-decoration:none">BECOME A PLAYLANE HOST &nbsp;&#8599;&#xFE0E;</a></td></tr></table>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your spot on the Lane</title>
<style>@media(max-width:600px){.shell{width:100%!important}.pad{padding-left:24px!important;padding-right:24px!important}.big{font-size:44px!important}.lbl{width:96px!important}}</style></head>
<body style="margin:0;background:#ece6c9;color:${INK}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Your RSVP is confirmed. Rye Lane, Saturday 31 October, 6PM, ${escapeHtml(EVENT.venue)}, ${escapeHtml(EVENT.address)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ece6c9"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" class="shell" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:${Y}">
<tr><td class="pad" style="padding:30px 40px 0" align="center"><img src="https://playlane.co/images/email/wordmark.png" width="170" height="25" alt="PLAYLANE" style="display:block;border:0;width:170px;height:25px"></td></tr>
<tr><td class="pad" style="padding:30px 40px 6px">
  <div class="big" style="font-family:Arial,Helvetica,sans-serif;font-weight:900;font-size:54px;line-height:1;letter-spacing:-2px;color:${R}">Look who’s joining Koko’s WatchLane. 👀</div>
  <p style="font-family:${serif};font-size:21px;line-height:1.4;margin:22px 0 0">${firstName}, your RSVP is confirmed. We’ve saved you a spot on the Lane.</p>
  <p style="font-family:${serif};font-size:17px;line-height:1.6;margin:14px 0 0;color:#3a372f">Good cinema, good food, music and an interesting mix of people. We’re making a night of it, and you’re part of the plan.</p>
</td></tr>
<tr><td class="pad" style="padding:28px 40px 8px" align="center"><img src="https://playlane.co/images/rsvp/rye-lane-poster-email.jpg" width="320" alt="Rye Lane, a film by Raine Allen-Miller" style="display:block;border:0;width:320px;max-width:100%;height:auto"></td></tr>
<tr><td class="pad" style="padding:22px 40px 6px">
  <div style="font-family:${mono};font-size:12px;font-weight:bold;letter-spacing:2px">THE FILM: RYE LANE 🎬</div>
  <p style="font-family:${serif};font-size:17px;line-height:1.6;margin:10px 0 0">A film by Raine Allen-Miller, starring David Jonsson and Vivian Oparah.<br><em>A little romance. A little chaos. A lot of South London.</em></p>
</td></tr>
<tr><td class="pad" style="padding:26px 40px 8px">
  <div style="font-family:${mono};font-size:12px;font-weight:bold;letter-spacing:2px;margin-bottom:12px">BEFORE YOU STEP ON THE LANE…</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid ${INK}">
    ${row("📅 WHEN", "Saturday 31 October 2026, 6PM")}
    ${row("📍 WHERE", `<strong>${escapeHtml(EVENT.venue)}</strong><br>${escapeHtml(EVENT.address)}<br><a href="${MAPS_URL}" target="_blank" style="font-family:${mono};font-size:13px;font-weight:bold;color:${INK}">OPEN IN MAPS &#8599;&#xFE0E;</a>`)}
    ${row("✨ DRESS", "Relaxed with spark. Pyjamas and heels? We see the vision. PlayLane is an occasion, after all.")}
    ${row("ACCESSORIES", "Your throw blanket.")}
    ${row("👯 PLUS ONES", "Bringing someone? Love that. Just make sure they RSVP separately. Spaces are limited, and every guest needs a confirmed spot.")}
  </table>
</td></tr>
<tr><td class="pad" style="padding:26px 40px 34px">
  <p style="font-family:${serif};font-size:17px;line-height:1.6;margin:0">That’s the housekeeping sorted.</p>
  <p style="font-family:${serif};font-size:17px;line-height:1.6;margin:12px 0 0">Come curious. Come ready to meet someone interesting. And don’t make too many plans for afterwards.</p>
  <p style="font-family:${serif};font-size:21px;font-style:italic;line-height:1.4;margin:22px 0 0">See you on the Lane,<br>Koko</p>
</td></tr>
<tr><td class="pad" style="background:${INK};padding:26px 40px 30px">
  <p style="font-family:${serif};font-size:16px;line-height:1.6;color:#fdfaf4;margin:0">${escapeHtml(postscript(hostStatus))}</p>
  ${hostButton}
  <div style="font-family:${mono};font-weight:bold;letter-spacing:2px;color:${Y};font-size:12px;margin-top:24px">WHERE YOU WATCH, WHERE YOU PLAY.</div>
</td></tr>
</table></td></tr></table></body></html>`;
}

// ─── Simple, letter-style version (no poster, no buttons) ────────────────
function getRsvpEmailHTMLSimple(firstName, hostStatus) {
  const p = (html, extra = "") => `<p style="margin:0 0 16px;${extra}">${html}</p>`;
  const line = (label, value) => `<strong>${label}:</strong> ${value}<br>`;
  const hostLine = hostStatus ? "" :
    ` Find out more at <a href="https://playlane.co/#host" style="color:#151412">playlane.co</a>.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your spot on the Lane</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<div style="max-width:560px;padding:24px 20px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#151412">
${p(`Hi ${firstName},`)}
${p("Look who’s joining Koko’s WatchLane. 👀")}
${p("Your RSVP is confirmed. We’ve saved you a spot on the Lane.")}
${p("Good cinema, good food, music and an interesting mix of people. We’re making a night of it, and you’re part of the plan.")}
${p("<strong>The film: Rye Lane 🎬</strong><br>A film by Raine Allen-Miller, starring David Jonsson and Vivian Oparah. A little romance. A little chaos. A lot of South London.")}
${p(
  line("📅 When", "Saturday 31 October 2026, 6PM") +
  line("📍 Where", `${escapeHtml(EVENT.venue)}, ${escapeHtml(EVENT.address)} (<a href="${MAPS_URL}" style="color:#151412">map</a>)`) +
  line("✨ Dress code", "Relaxed with spark. Pyjamas and heels? We see the vision. PlayLane is an occasion, after all.") +
  line("Accessories", "Your throw blanket.") +
  `<strong>👯 Plus ones:</strong> Bringing someone? Love that. Just make sure they RSVP separately. Spaces are limited, and every guest needs a confirmed spot.`
)}
${p("That’s the housekeeping sorted. Come curious. Come ready to meet someone interesting. And don’t make too many plans for afterwards.")}
${p("Any questions? Just reply to this email.")}
${p("See you on the Lane,<br>Koko")}
${p(escapeHtml(postscript(hostStatus)) + hostLine, "color:#555")}
</div></body></html>`;
}
