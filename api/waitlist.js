// api/waitlist.js
// Vercel serverless function — saves to Airtable + sends confirmation email via Resend

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // CORS headers (in case your form needs them)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const { name, email } = req.body;

    // Basic validation
    if (!name || !email) {
      return res.status(400).json({ error: "Name and email are required." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    // 1. Save to Airtable
    const airtableRes = await fetch(
      `https://api.airtable.com/v0/app52y6eaXlU3Bpkj/${encodeURIComponent("Waitlist")}`,
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
                Status: "New",
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

    // 2. Send confirmation email via Resend
    const firstName = name.split(" ")[0];

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Playlane <onboarding@resend.dev>",
        to: [email],
        subject: "You're in. The front row is yours.",
        html: getEmailHTML(firstName),
      }),
    });

    if (!emailRes.ok) {
      console.error("Resend error:", await emailRes.json());
      // Still return success — signup was saved
    }

    // 3. Update Airtable status to "Emailed"
    const airtableData = await airtableRes.json();
    const recordId = airtableData.records?.[0]?.id;

    if (recordId) {
      await fetch(
        `https://api.airtable.com/v0/app52y6eaXlU3Bpkj/${encodeURIComponent("Waitlist")}/${recordId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            fields: { Status: "Emailed" },
          }),
        }
      );
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Waitlist error:", error);
    return res.status(500).json({ error: "Something went wrong." });
  }
}

// ─── Branded email template ───────────────────────────────────────────

function getEmailHTML(firstName) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin: 0; padding: 0; background-color: #f5f3ee; font-family: Georgia, 'Times New Roman', serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f5f3ee;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background-color: #fffef9; border-radius: 12px; overflow: hidden;">
          <tr>
            <td style="height: 4px; background-color: #f5e6a3;"></td>
          </tr>
          <tr>
            <td style="padding: 40px 40px 0 40px;">
              <p style="margin: 0; font-size: 14px; letter-spacing: 3px; color: #8a8578; text-transform: uppercase;">
                Playlane
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 40px 0 40px;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 400; color: #2c2a25; line-height: 1.3;">
                You've got a seat,<br />
                <em>${firstName}.</em>
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 40px 0 40px;">
              <p style="margin: 0; font-size: 16px; line-height: 1.7; color: #5c5a53;">
                Thanks for joining the waitlist. You'll be among the first to know when Playlane launches in your neighbourhood.
              </p>
              <p style="margin: 20px 0 0 0; font-size: 16px; line-height: 1.7; color: #5c5a53;">
                We're building something different — a place where films aren't watched alone on couches, but shared in living rooms, rooftops, and gardens with people who live nearby. Cinema that only plays when people gather.
              </p>
              <p style="margin: 20px 0 0 0; font-size: 16px; line-height: 1.7; color: #5c5a53;">
                Until then, keep an eye on your inbox. When your city goes live, you'll get a personal invite.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 40px 0 40px;">
              <hr style="border: none; border-top: 1px solid #e8e5dd; margin: 0;" />
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 40px 40px 40px;">
              <p style="margin: 0; font-size: 13px; color: #a8a49a; line-height: 1.6;">
                Playlane — cinema that won't play alone.<br />
                Alexander Phi Ltd · London, UK
              </p>
              <p style="margin: 12px 0 0 0; font-size: 12px; color: #c5c1b8;">
                You're receiving this because you signed up at playlane.co
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
