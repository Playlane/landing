// api/waitlist.js
// Vercel serverless function — saves to Airtable + sends confirmation email via Resend

// Airtable table that stores hosts (fields: Name, Email, Phone, Location)
const HOSTS_TABLE = "Hosts";

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const { name, email } = req.body;
    const phone = typeof req.body.phone === "string" ? req.body.phone.trim().slice(0, 20) : "";
    const location = typeof req.body.location === "string" ? req.body.location.trim().slice(0, 100) : "";

    // Basic validation
    if (!name || !email || !phone || !location) {
      return res.status(400).json({ error: "Name, email, phone number and location are required." });
    }

    const phoneDigits = phone.replace(/\D/g, "").length;
    if (!/^\+?[\d\s().-]+$/.test(phone) || phoneDigits < 7 || phoneDigits > 15) {
      return res.status(400).json({ error: "Please enter a valid phone number." });
    }

    // Invite link for the hosts' WhatsApp group (set in Vercel env vars)
    const whatsappUrl = process.env.WHATSAPP_HOST_GROUP_URL || "";

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    // ── Check for duplicate email ──────────────────────────────────
    const checkRes = await fetch(
      `https://api.airtable.com/v0/app52y6eaXlU3Bpkj/${encodeURIComponent(HOSTS_TABLE)}?filterByFormula=${encodeURIComponent(`{Email}="${email}"`)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN}`,
        },
      }
    );

    if (checkRes.ok) {
      const checkData = await checkRes.json();
      if (checkData.records && checkData.records.length > 0) {
        return res.status(409).json({ error: "duplicate", message: "This email is already signed up as a host." });
      }
    }

    // ── 1. Save to Airtable ────────────────────────────────────────
    const airtableRes = await fetch(
      `https://api.airtable.com/v0/app52y6eaXlU3Bpkj/${encodeURIComponent(HOSTS_TABLE)}`,
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
                Location: location,
              },
            },
          ],
        }),
      }
    );

    if (!airtableRes.ok) {
      const err = await airtableRes.json();
      console.error("Airtable error:", err);
      return res.status(500).json({ error: "Failed to save signup." });
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
      console.error("Resend error:", await emailRes.json());
    }

    return res.status(200).json({ success: true, whatsappUrl });
  } catch (error) {
    console.error("Host signup error:", error);
    return res.status(500).json({ error: "Something went wrong." });
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
