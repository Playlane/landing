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
  if (type === "UNKNOWN_FIELD_NAME") {
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

    // ── Check for duplicate email ──────────────────────────────────
    const checkRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(HOSTS_TABLE)}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN}`,
        },
      }
    );

    if (checkRes.ok) {
      const checkData = await readJson(checkRes);
      if (checkData && checkData.records && checkData.records.length > 0) {
        return res.status(409).json({ error: "duplicate", message: "This email is already signed up as a host. Try a different email, or email helloneighbour@playlane.co if you need to update your details." });
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
    const firstName = name.split(" ")[0];

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Playlane <helloneighbour@playlane.co>",
        to: [email],
        subject: "Welcome, host. Your screen is ready.",
        html: getEmailHTML(firstName, whatsappUrl),
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

function getEmailHTML(firstName, whatsappUrl) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to Playlane Host</title>
  <link href="https://fonts.googleapis.com/css2?family=Silkscreen&display=swap" rel="stylesheet" />
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Silkscreen&display=swap');
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f0e8; font-family: Georgia, 'Times New Roman', serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f0e8;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="580" cellspacing="0" cellpadding="0" style="max-width: 580px; width: 100%;">
          <tr>
            <td align="center" style="padding: 0 0 32px 0;">
              <span style="font-family: 'Silkscreen', 'Courier New', monospace; font-size: 22px; font-weight: bold; color: #161412; letter-spacing: 4px; text-transform: uppercase;">PLAYLANE</span>
            </td>
          </tr>
          <tr>
            <td>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #161412; border-radius: 20px; overflow: hidden;">
                <tr>
                  <td align="center" style="padding: 60px 40px 20px 40px;">
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
                  <td align="center" style="padding: 16px 40px 12px 40px;">
                    <h1 style="margin: 0; font-family: Georgia, 'Times New Roman', serif; font-size: 32px; font-weight: 400; color: #ffffff; line-height: 1.2; letter-spacing: -0.5px;">
                      You're a Playlane host!
                    </h1>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 0 40px 48px 40px;">
                    <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; color: rgba(255,255,255,0.5); letter-spacing: 2px; text-transform: uppercase;">
                      Welcome aboard, ${firstName}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #fffef9; border-radius: 0 0 20px 20px; border: 1px solid rgba(22,20,18,0.06); border-top: none;">
                <tr>
                  <td style="padding: 36px 40px 0 40px;">
                    <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.75; color: #5c5a53;">
                      Hey ${firstName},
                    </p>
                    <p style="margin: 18px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.75; color: #5c5a53;">
                      Thanks for signing up to host on Playlane. You're joining a group of people opening their living rooms, rooftops and gardens to films and neighbours.
                    </p>
                    <p style="margin: 18px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.75; color: #5c5a53;">
                      We're building something different, a place where films aren't watched alone, but shared in living rooms, rooftops, and gardens with people who live nearby. Cinema that only plays when people gather.
                    </p>
                    <p style="margin: 18px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.75; color: #5c5a53;">
                      Next step: join the hosts' WhatsApp group. It's where we share hosting tips, plan first screenings and connect you with other hosts near you.
                    </p>
                    ${whatsappUrl ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin: 26px 0 0 0;"><tr><td style="background-color: #25D366; border-radius: 10px;">
                      <a href="${whatsappUrl}" target="_blank" style="display: inline-block; padding: 14px 28px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; font-weight: 600; color: #0b2e17; text-decoration: none; letter-spacing: 0.5px;">Join the hosts' WhatsApp group</a>
                    </td></tr></table>` : ""}
                  </td>
                </tr>
                <tr>
                  <td style="padding: 32px 40px 0 40px;">
                    <hr style="border: none; border-top: 1px solid #e8e5dd; margin: 0;" />
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 24px 40px 8px 40px;">
                    <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #a8a49a; letter-spacing: 0.5px;">
                      Follow the journey
                    </p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 12px 40px 0 40px;">
                    <table role="presentation" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="padding: 0 12px;">
                          <a href="https://instagram.com/joinplaylane" target="_blank" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #161412; text-decoration: none; font-weight: 500;">Instagram</a>
                        </td>
                        <td style="color: #d0cdc5;">&middot;</td>
                        <td style="padding: 0 12px;">
                          <a href="https://tiktok.com/@joinplaylane" target="_blank" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #161412; text-decoration: none; font-weight: 500;">TikTok</a>
                        </td>
                        <td style="color: #d0cdc5;">&middot;</td>
                        <td style="padding: 0 12px;">
                          <a href="https://x.com/joinplaylane" target="_blank" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #161412; text-decoration: none; font-weight: 500;">X</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 28px 40px 0 40px;">
                    <hr style="border: none; border-top: 1px solid #e8e5dd; margin: 0;" />
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 24px 40px 36px 40px;">
                    <p style="margin: 0; font-family: Georgia, 'Times New Roman', serif; font-size: 14px; color: #a8a49a; line-height: 1.6; font-style: italic;">
                      Cinema that won't play alone.
                    </p>
                    <p style="margin: 10px 0 0 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 11px; color: #c5c1b8; line-height: 1.5;">
                      PLAYLANE &middot; London, United Kingdom<br />
                      You're receiving this because you signed up at playlane.co
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
