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

const EMAIL_SUBJECT = "Welcome to PlayLane. You’re a Host. 🎬";

// Names are typed by visitors, so escape them before putting them in the email
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// Plain-text version (shown by email apps that don't display HTML; also helps avoid spam folders)
function getEmailText(firstName, whatsappUrl) {
  return [
    "WELCOME, HOST.",
    "",
    `Hi ${firstName},`,
    "",
    "Welcome to PlayLane.",
    "",
    "You’re joining a group of people who believe film can give us more reasons to come together.",
    "",
    "We’re starting with African cinema, creating more places for films to meet audiences and more opportunities for people to experience them together, closer to their neighbourhoods.",
    "",
    "As a PlayLane Host, you’re the person who brings people together.",
    "",
    "You don’t need to own a cinema. You don’t even need to have a venue.",
    "",
    "A PlayLane screening could happen in a residential communal space, community centre, community theatre or another suitable local space. And if you don’t have one in mind yet, that’s okay.",
    "",
    "Being a Host starts with people, not a venue.",
    "",
    "And this is about more than putting a film on a screen.",
    "",
    "The atmosphere. The welcome. The people. The film. The reactions. The conversations afterwards.",
    "",
    "We want every screening to feel like an occasion.",
    "",
    "And when you host, you can earn too.",
    "",
    "PlayLane Hosts can earn commission from the screenings they successfully host. So as you bring people together and help films reach new audiences, there’s an opportunity for you to share in the value you help create.",
    "",
    "WHAT HAPPENS NEXT?",
    "",
    whatsappUrl
      ? `Join the PlayLane Hosts WhatsApp group to meet other Hosts, hear about our first screenings and start getting ready to host:\n${whatsappUrl}`
      : "We’ll send you the link to the PlayLane Hosts WhatsApp group, where you’ll meet other Hosts, hear about our first screenings and start getting ready to host.",
    "",
    "We’re glad you’re here.",
    "",
    "Let’s host cinema.",
    "PlayLane",
    "",
    "—",
    "You’re receiving this because you signed up as a Host at playlane.co",
  ].join("\n");
}

function getEmailHTML(firstName, whatsappUrl) {
  const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
  const serif = "Georgia, 'Times New Roman', serif";
  const p = (text, extra = "") =>
    `<p style="margin: 18px 0 0 0; font-family: ${sans}; font-size: 15px; line-height: 1.75; color: #5c5a53;${extra}">${text}</p>`;
  const nextStep = whatsappUrl
    ? `Join the PlayLane Hosts WhatsApp group to meet other Hosts, hear about our first screenings and start getting ready to host.`
    : `We&rsquo;ll send you the link to the PlayLane Hosts WhatsApp group, where you&rsquo;ll meet other Hosts, hear about our first screenings and start getting ready to host.`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to PlayLane. You&rsquo;re a Host.</title>
  <link href="https://fonts.googleapis.com/css2?family=Silkscreen&display=swap" rel="stylesheet" />
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Silkscreen&display=swap');
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f0e8; font-family: ${serif}; -webkit-font-smoothing: antialiased;">
  <!-- Inbox preview text -->
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">Being a Host starts with people, not a venue. Here&rsquo;s what happens next.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f0e8;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="580" cellspacing="0" cellpadding="0" style="max-width: 580px; width: 100%;">
          <tr>
            <td align="center" style="padding: 0 0 32px 0;">
              <span style="font-family: 'Silkscreen', 'Courier New', monospace; font-size: 22px; font-weight: bold; color: #161412; letter-spacing: 4px; text-transform: uppercase;">PLAYLANE</span>
            </td>
          </tr>

          <!-- Header card -->
          <tr>
            <td>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #161412; border-radius: 20px 20px 0 0; overflow: hidden;">
                <tr>
                  <td align="center" style="padding: 56px 40px 20px 40px;">
                    <table role="presentation" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="width: 10px; height: 10px; border-radius: 50%; background-color: #FFF69A;"></td>
                        <td style="width: 8px;"></td>
                        <td style="width: 8px; height: 8px; border-radius: 50%; background-color: #a8e8c0;"></td>
                        <td style="width: 8px;"></td>
                        <td style="width: 6px; height: 6px; border-radius: 50%; background-color: #c5a0e8;"></td>
                        <td style="width: 8px;"></td>
                        <td style="width: 10px; height: 10px; border-radius: 50%; background-color: #FFF69A;"></td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 16px 40px 52px 40px;">
                    <h1 style="margin: 0; font-family: ${serif}; font-size: 34px; font-weight: 400; color: #ffffff; line-height: 1.2; letter-spacing: 3px; text-transform: uppercase;">
                      Welcome, Host.
                    </h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fffef9; border-radius: 0 0 20px 20px; border: 1px solid rgba(22,20,18,0.06); border-top: none;">
                <tr>
                  <td style="padding: 22px 40px 0 40px;">
                    ${p(`Hi ${firstName},`)}
                    ${p(`Welcome to PlayLane.`)}
                    ${p(`You&rsquo;re joining a group of people who believe film can give us more reasons to come together.`)}
                    ${p(`We&rsquo;re starting with African cinema, creating more places for films to meet audiences and more opportunities for people to experience them together, closer to their neighbourhoods.`)}
                    ${p(`As a PlayLane Host, you&rsquo;re the person who brings people together.`)}
                    ${p(`You don&rsquo;t need to own a cinema. You don&rsquo;t even need to have a venue.`)}
                    ${p(`A PlayLane screening could happen in a residential communal space, community centre, community theatre or another suitable local space. And if you don&rsquo;t have one in mind yet, that&rsquo;s okay.`)}
                    ${p(`Being a Host starts with people, not a venue.`, ` font-family: ${serif}; font-size: 19px; color: #161412; font-style: italic;`)}
                    ${p(`And this is about more than putting a film on a screen.`)}
                    ${p(`The atmosphere. The welcome. The people. The film. The reactions. The conversations afterwards.`, ` color: #161412;`)}
                    ${p(`We want every screening to feel like an occasion.`)}
                  </td>
                </tr>

                <!-- Earn callout -->
                <tr>
                  <td style="padding: 28px 40px 0 40px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f0e8; border-radius: 14px;">
                      <tr>
                        <td style="padding: 22px 24px 24px 24px;">
                          <p style="margin: 0; font-family: ${serif}; font-size: 20px; line-height: 1.4; color: #161412;">And when you host, you can earn too.</p>
                          <p style="margin: 12px 0 0 0; font-family: ${sans}; font-size: 15px; line-height: 1.75; color: #5c5a53;">PlayLane Hosts can earn commission from the screenings they successfully host. So as you bring people together and help films reach new audiences, there&rsquo;s an opportunity for you to share in the value you help create.</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- What happens next -->
                <tr>
                  <td style="padding: 32px 40px 0 40px;">
                    <p style="margin: 0; font-family: ${sans}; font-size: 12px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: #161412;">What happens next?</p>
                    ${p(nextStep, " margin-top: 12px;")}
                    ${whatsappUrl ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin: 24px 0 0 0;"><tr><td style="background-color: #25D366; border-radius: 10px;">
                      <a href="${whatsappUrl}" target="_blank" style="display: inline-block; padding: 15px 28px; font-family: ${sans}; font-size: 13px; font-weight: 700; color: #0b2e17; text-decoration: none; letter-spacing: 1px; text-transform: uppercase;">Join the Hosts&rsquo; WhatsApp group</a>
                    </td></tr></table>` : ""}
                  </td>
                </tr>

                <!-- Sign-off -->
                <tr>
                  <td style="padding: 32px 40px 0 40px;">
                    <p style="margin: 0; font-family: ${sans}; font-size: 15px; line-height: 1.75; color: #5c5a53;">We&rsquo;re glad you&rsquo;re here.</p>
                    <p style="margin: 18px 0 0 0; font-family: ${serif}; font-size: 20px; line-height: 1.4; color: #161412; font-style: italic;">Let&rsquo;s host cinema.</p>
                    <p style="margin: 6px 0 0 0; font-family: ${sans}; font-size: 15px; line-height: 1.75; color: #161412; font-weight: 600;">PlayLane</p>
                  </td>
                </tr>

                <tr>
                  <td style="padding: 32px 40px 0 40px;">
                    <hr style="border: none; border-top: 1px solid #e8e5dd; margin: 0;" />
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 24px 40px 8px 40px;">
                    <p style="margin: 0; font-family: ${sans}; font-size: 13px; color: #a8a49a; letter-spacing: 0.5px;">Follow the journey</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 12px 40px 0 40px;">
                    <table role="presentation" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="padding: 0 12px;"><a href="https://instagram.com/joinplaylane" target="_blank" style="font-family: ${sans}; font-size: 13px; color: #161412; text-decoration: none; font-weight: 500;">Instagram</a></td>
                        <td style="color: #d0cdc5;">&middot;</td>
                        <td style="padding: 0 12px;"><a href="https://tiktok.com/@joinplaylane" target="_blank" style="font-family: ${sans}; font-size: 13px; color: #161412; text-decoration: none; font-weight: 500;">TikTok</a></td>
                        <td style="color: #d0cdc5;">&middot;</td>
                        <td style="padding: 0 12px;"><a href="https://x.com/joinplaylane" target="_blank" style="font-family: ${sans}; font-size: 13px; color: #161412; text-decoration: none; font-weight: 500;">X</a></td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 28px 40px 36px 40px;">
                    <p style="margin: 0; font-family: ${sans}; font-size: 11px; color: #b5b1a8; line-height: 1.6;">
                      PLAYLANE &middot; London, United Kingdom<br />
                      You&rsquo;re receiving this because you signed up as a Host at playlane.co
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
