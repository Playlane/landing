// api/waitlist.js
// Vercel serverless function — saves to Airtable + sends confirmation email via Resend

// Airtable base and table that store hosts (fields: Name, Email, Phone, City, Country).
// IDs come from the table's address: airtable.com/<BASE_ID>/<TABLE_ID>/...
// Using the table ID (not its name) means renaming the tab in Airtable won't break sign-ups.
const AIRTABLE_BASE_ID = "app3DdTXYXOPuzs0V";
const HOSTS_TABLE = "tblqrXUZZcZaStDZO"; // the "Hosts" table

// Shown to the visitor whenever saving fails for a reason that isn't their fault
const SAVE_FAILED_MESSAGE =
  "We couldn't save your details because of a problem on our side, not with what you typed. " +
  "Please try again later, or email helloneighbour@playlane.co and we'll add you.";

// Error codes shown to the visitor as "Error code: …" and what each one means for you.
// The full details always appear in Vercel → your project → Logs.
//   DB_AUTH       Airtable token missing or invalid. Check AIRTABLE_PERSONAL_ACCESS_TOKEN in Vercel.
//   DB_TABLE      Table not found, or the token can't access it. Check the token's Access list
//                 includes this base (AIRTABLE_BASE_ID) and scopes data.records:read + write.
//   DB_FIELD      A field name doesn't match. Fields must be exactly: Name, Email, Phone, City, Country.
//   DB_FIELD_TYPE A field has the wrong type (e.g. a single-select). Use "Single line text".
//   DB_BUSY       Airtable rate limit. Usually fixes itself within a minute.
//   DB_ERROR      Any other Airtable problem. See the log for Airtable's message.
//   SERVER_ERROR  Unexpected crash in this function. See the log for the stack trace.
function describeAirtableError(status, body) {
  const type = (body && body.error && body.error.type) || (body && typeof body.error === "string" && body.error) || "";
  if (status === 401 || type === "AUTHENTICATION_REQUIRED") {
    return { code: "DB_AUTH", hint: "Airtable token missing or invalid (AIRTABLE_PERSONAL_ACCESS_TOKEN)." };
  }
  if (status === 403 || status === 404 || type === "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND" || type === "NOT_FOUND" || type === "TABLE_NOT_FOUND") {
    return { code: "DB_TABLE", hint: `Hosts table (${AIRTABLE_BASE_ID}/${HOSTS_TABLE}) not found, or the Airtable token has no access to this base.` };
  }
  if (type === "UNKNOWN_FIELD_NAME" || type === "INVALID_FILTER_BY_FORMULA") {
    return { code: "DB_FIELD", hint: "A field name doesn't match Airtable. Expected: Name, Email, Phone, City, Country." };
  }
  if (type === "INVALID_MULTIPLE_CHOICE_OPTIONS" || type === "INVALID_VALUE_FOR_COLUMN" || type === "INVALID_REQUEST_UNKNOWN") {
    return { code: "DB_FIELD_TYPE", hint: "A field has the wrong type in Airtable. Use Single line text." };
  }
  if (status === 429) {
    return { code: "DB_BUSY", hint: "Airtable rate limit hit." };
  }
  return { code: "DB_ERROR", hint: `Unexpected Airtable response (HTTP ${status}${type ? ", " + type : ""}).` };
}

// Text inside an Airtable formula string: escape backslashes and quotes
function formulaString(text) {
  return '"' + String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// Phone numbers get typed many ways (+44 7700 900123, 07700900123, 447700900123).
// Compare digits only, and treat numbers as the same if their last 9 digits match,
// which covers the same number written with or without the country code.
const PHONE_MATCH_DIGITS = 9;
function phoneDigitsOf(text) { return String(text || "").replace(/\D/g, ""); }
function samePhone(a, b) {
  const da = phoneDigitsOf(a), db = phoneDigitsOf(b);
  if (!da || !db) return false;
  if (da === db) return true;
  return da.length >= PHONE_MATCH_DIGITS && db.length >= PHONE_MATCH_DIGITS &&
    da.slice(-PHONE_MATCH_DIGITS) === db.slice(-PHONE_MATCH_DIGITS);
}

const DUPLICATE_MESSAGES = {
  email: "This email is already registered as a Playlane host. Try a different email, or email helloneighbour@playlane.co to update your details.",
  phone: "This WhatsApp number is already registered as a Playlane host. Try a different number, or email helloneighbour@playlane.co to update your details.",
  both: "You're already registered as a Playlane host with this email and WhatsApp number. To update your details or get the WhatsApp group link again, email helloneighbour@playlane.co.",
};

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed", message: "Method not allowed." });
  }

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const body = req.body || {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 20) : "";
    const city = typeof body.city === "string" ? body.city.trim().slice(0, 80) : "";
    const country = typeof body.country === "string" ? body.country.trim().slice(0, 80) : "";

    // Validation: tell the visitor exactly which field to fix
    const invalid = (field, message) => res.status(400).json({ error: "invalid", field, message });
    if (!name) return invalid("name", "Please enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return invalid("email", "Please enter a valid email address, like name@example.com.");
    const phoneDigits = phone.replace(/\D/g, "").length;
    if (!/^\+?[\d\s().-]+$/.test(phone) || phoneDigits < 7 || phoneDigits > 15) {
      return invalid("phone", "Please enter a valid phone number with your country code, like +44 7700 900123.");
    }
    if (!city) return invalid("city", "Please choose your city.");

    // Invite link for the hosts' WhatsApp group (set in Vercel env vars)
    const whatsappUrl = process.env.WHATSAPP_HOST_GROUP_URL || "";
    if (!whatsappUrl) {
      console.warn("[signup] WHATSAPP_HOST_GROUP_URL is not set in Vercel, so no WhatsApp button will show.");
    }

    // Fail fast with a clear code if the Airtable token isn't configured
    if (!process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN) {
      console.error("[signup] DB_AUTH: AIRTABLE_PERSONAL_ACCESS_TOKEN is not set for this environment in Vercel.");
      return res.status(500).json({ error: "save_failed", code: "DB_AUTH", message: SAVE_FAILED_MESSAGE });
    }

    // ── Check whether this email or WhatsApp number is already a host ─────
    // Email: case-insensitive. Phone: digits only, last 9 digits (see samePhone).
    const digits = phoneDigitsOf(phone);
    const phoneInAirtable = `REGEX_REPLACE({Phone} & "", "[^0-9]", "")`;
    const duplicateFormula =
      `OR(` +
        `LOWER(TRIM({Email} & "")) = ${formulaString(email.toLowerCase())}, ` +
        `${phoneInAirtable} = ${formulaString(digits)}, ` +
        `AND(LEN(${phoneInAirtable}) >= ${PHONE_MATCH_DIGITS}, RIGHT(${phoneInAirtable}, ${PHONE_MATCH_DIGITS}) = ${formulaString(digits.slice(-PHONE_MATCH_DIGITS))})` +
      `)`;
    const checkUrl =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(HOSTS_TABLE)}` +
      `?maxRecords=10&fields%5B%5D=Email&fields%5B%5D=Phone&filterByFormula=${encodeURIComponent(duplicateFormula)}`;
    const checkRes = await fetch(
      checkUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN}`,
        },
      }
    );

    if (checkRes.ok) {
      const checkData = await readJson(checkRes);
      const matches = (checkData && checkData.records) || [];
      if (matches.length > 0) {
        const emailTaken = matches.some(r => String((r.fields && r.fields.Email) || "").trim().toLowerCase() === email.toLowerCase());
        const phoneTaken = matches.some(r => samePhone(r.fields && r.fields.Phone, phone));
        const field = emailTaken && phoneTaken ? "both" : emailTaken ? "email" : phoneTaken ? "phone" : "both";
        console.log(`[signup] Duplicate host blocked (${field}).`);
        return res.status(409).json({ error: "duplicate", field, message: DUPLICATE_MESSAGES[field] });
      }
    } else {
      // The save below will almost certainly fail for the same reason, so report it now
      const checkErr = await readJson(checkRes);
      const problem = describeAirtableError(checkRes.status, checkErr);
      console.error(`[signup] ${problem.code} (duplicate check): ${problem.hint}`, JSON.stringify(checkErr));
      return res.status(problem.code === "DB_BUSY" ? 503 : 500).json({
        error: "save_failed",
        code: problem.code,
        message: problem.code === "DB_BUSY" ? "Lots of people are signing up right now. Please wait a minute and try again." : SAVE_FAILED_MESSAGE,
      });
    }

    // ── 1. Save to Airtable ────────────────────────────────────────
    const airtableRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(HOSTS_TABLE)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          records: [
            {
              fields: {
                Name: name,
                Email: email,
                Phone: phone,
                City: city,
                ...(country ? { Country: country } : {}),
              },
            },
          ],
        }),
      }
    );

    if (!airtableRes.ok) {
      const saveErr = await readJson(airtableRes);
      const problem = describeAirtableError(airtableRes.status, saveErr);
      console.error(`[signup] ${problem.code} (saving record): ${problem.hint}`, JSON.stringify(saveErr));
      return res.status(problem.code === "DB_BUSY" ? 503 : 500).json({
        error: "save_failed",
        code: problem.code,
        message: problem.code === "DB_BUSY" ? "Lots of people are signing up right now. Please wait a minute and try again." : SAVE_FAILED_MESSAGE,
      });
    }

    // ── 2. Send confirmation email via Resend ──────────────────────
    const firstName = escapeHtml(name.split(/\s+/)[0].slice(0, 40));

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "PlayLane <helloneighbour@playlane.co>",
        to: [email],
        subject: EMAIL_SUBJECT,
        html: getEmailHTML(firstName, whatsappUrl),
        text: getEmailText(name.split(/\s+/)[0].slice(0, 40), whatsappUrl),
      }),
    });

    if (!emailRes.ok) {
      // The signup is saved; only the confirmation email failed. Check RESEND_API_KEY in Vercel.
      console.error("[signup] EMAIL_FAILED: confirmation email not sent.", JSON.stringify(await readJson(emailRes)));
    }

    return res.status(200).json({ success: true, whatsappUrl });
  } catch (error) {
    console.error("[signup] SERVER_ERROR:", error);
    return res.status(500).json({ error: "server_error", code: "SERVER_ERROR", message: SAVE_FAILED_MESSAGE });
  }
}

// ─── Branded email template ───────────────────────────────────────────

export const EMAIL_SUBJECT = "You’re in. Welcome to the Lane.";

// Names are typed by visitors, so escape them before putting them in the email
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// Plain-text version (shown by email apps that don't display HTML; also helps avoid spam folders)
export function getEmailText(firstName, whatsappUrl) {
  return [
    "WELCOME TO THE LANE",
    "",
    "You’re in.",
    "",
    "Good films. Great company. Your neighbourhood.",
    "",
    "01 / THE GOOD PART",
    "",
    "The night starts before the film.",
    "",
    "Welcome to PlayLane’s first circle of Lane Chiefs.",
    "",
    "You bring your taste, your local knowledge and your instinct for getting people together. We help turn that into a film night worth leaving home for.",
    "",
    "YOU BRING: The people. The taste. The ideas.",
    "WE HANDLE: Film rights. Venue approval. Ticketing.",
    "",
    "Approved screenings can earn you an agreed share of ticket revenue. We’ll explain the details before your first event.",
    "",
    "02 / FIRST THINGS FIRST",
    "",
    "Come meet your people.",
    "",
    whatsappUrl
      ? `Join the Hosts’ WhatsApp group to meet other Lane Chiefs, hear what’s coming and get ready for your first screening:\n${whatsappUrl}`
      : "We’ll send you the link to the Hosts’ WhatsApp group, where you’ll meet other Lane Chiefs, hear what’s coming and get ready for your first screening.",
    "",
    "See you in the Lane.",
    "",
    "WHERE YOU WATCH, WHERE YOU PLAY.",
    "PLAYLANE © COPYRIGHT 2026",
  ].join("\n");
}

// The design's ↗ and ✳ are followed by &#xFE0E; so phones show them as plain text symbols, not coloured emoji
export function getEmailHTML(firstName, whatsappUrl) {
  const whatsappBlock = whatsappUrl
    ? `<p style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.6;color:#333;margin:0 0 25px">Join the Hosts' WhatsApp group to meet other Lane Chiefs, hear what's coming and get ready for your first screening.</p><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td style="background:#f7ec83;padding:20px 21px"><a href="${whatsappUrl}" target="_blank" style="display:block;text-decoration:none;color:#111;font-family:'Courier New',monospace;font-size:15px;font-weight:bold;letter-spacing:.5px">JOIN THE HOSTS' GROUP &nbsp; &#8599;&#xFE0E;</a></td></tr></table>`
    : `<p style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.6;color:#333;margin:0">We'll send you the link to the Hosts' WhatsApp group, where you'll meet other Lane Chiefs, hear what's coming and get ready for your first screening.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PlayLane | You're in</title><style>@media(max-width:600px){.shell{width:100%!important}.pad{padding-left:25px!important;padding-right:25px!important}.hero{font-size:64px!important;line-height:.95!important}.intro{font-size:22px!important}.smalltitle{font-size:26px!important}} </style></head><body style="margin:0;background:#e8e5dd;font-family:Arial,Helvetica,sans-serif;color:#171717"><div style="display:none;max-height:0;overflow:hidden;opacity:0">You're in. Welcome to the Lane. Your next film night starts here.</div><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#e8e5dd"><tr><td align="center" style="padding:30px 12px"><table role="presentation" class="shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#f8f5ed"><tr><td class="pad" style="padding:35px 42px 27px"><table role="presentation" width="100%"><tr><td style="font-family:'Courier New',monospace;font-weight:900;letter-spacing:3px;font-size:26px;color:#111"><img src="https://playlane.co/images/email/wordmark.png" width="203" height="30" alt="PLAYLANE" style="display:block;border:0;outline:none;width:203px;height:30px"></td><td align="right" style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:1px">LANE CHIEFS / 001</td></tr></table></td></tr><tr><td style="background:#171717;padding:54px 42px 60px" class="pad"><div style="font-family:'Courier New',monospace;font-size:12px;letter-spacing:2px;font-weight:bold;color:#f7ec83;margin-bottom:30px">WELCOME TO THE LANE &nbsp; &#10035;&#xFE0E;</div><div class="hero" style="font-family:Georgia,'Times New Roman',serif;font-size:86px;line-height:.94;letter-spacing:-4px;color:#fff">You're<br><em style="font-weight:normal">in.</em></div><div style="width:86px;height:7px;background:#f7ec83;margin-top:34px"></div><p class="intro" style="font-family:Georgia,'Times New Roman',serif;font-size:25px;line-height:1.27;color:#fff;margin:29px 0 0">Good films. Great company.<br>Your neighbourhood.</p></td></tr><tr><td class="pad" style="padding:49px 42px 12px"><div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;font-weight:bold;margin-bottom:20px">01 / THE GOOD PART</div><p style="font-family:Georgia,'Times New Roman',serif;font-size:31px;line-height:1.18;margin:0 0 22px">The night starts<br><em>before the film.</em></p><p style="font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.65;color:#333;margin:0 0 18px">Welcome to PlayLane's first circle of Lane Chiefs.</p><p style="font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.65;color:#333;margin:0">You bring your taste, your local knowledge and your instinct for getting people together. We help turn that into a film night worth leaving home for.</p></td></tr><tr><td class="pad" style="padding:36px 42px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #171717;border-bottom:1px solid #171717"><tr><td style="padding:22px 0;font-family:'Courier New',monospace;font-size:13px;line-height:1.7"><strong>YOU BRING</strong><br>THE PEOPLE. THE TASTE. THE IDEAS.</td></tr><tr><td style="padding:0 0 22px;font-family:'Courier New',monospace;font-size:13px;line-height:1.7"><strong>WE HANDLE</strong><br>FILM RIGHTS. VENUE APPROVAL. TICKETING.</td></tr></table><p style="font-family:Georgia,'Times New Roman',serif;font-size:14px;line-height:1.6;color:#68665f;margin:18px 0 0">Approved screenings can earn you an agreed share of ticket revenue. We'll explain the details before your first event.</p></td></tr><tr><td class="pad" style="padding:28px 42px 54px"><div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;font-weight:bold;margin-bottom:18px">02 / FIRST THINGS FIRST</div><p class="smalltitle" style="font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.2;margin:0 0 15px">Come meet<br>your people.</p>${whatsappBlock}</td></tr><tr><td style="background:#171717;padding:31px 42px 35px" class="pad"><p style="font-family:Georgia,'Times New Roman',serif;font-size:23px;font-style:italic;color:#fff;margin:0 0 25px">See you in the Lane.</p><div style="font-family:'Courier New',monospace;font-weight:bold;letter-spacing:2px;color:#f7ec83;font-size:12px">WHERE YOU WATCH, WHERE YOU PLAY.</div><div style="margin-top:21px;font-size:11px;color:#b5b2ac"><img src="https://playlane.co/images/email/footer-copyright.png" width="265" height="16" alt="PLAYLANE &copy; COPYRIGHT 2026" style="display:block;border:0;outline:none;width:265px;height:16px;max-width:100%"></div></td></tr></table></td></tr></table></body></html>`;
}
