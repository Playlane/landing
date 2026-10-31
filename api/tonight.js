// api/tonight.js
// One-off "Tonight, we're on the Lane" email to everyone on the RSVP list.
//
//   GET  /api/tonight?key=…              → preview page: the email + how many guests it will go to
//   POST /api/tonight?key=…&test=EMAIL   → sends ONE test copy to EMAIL
//   POST /api/tonight?key=…              → sends to every RSVP (each guest gets it at most once,
//                                          even if the button is pressed twice)
//
// Needs the Vercel environment variable BROADCAST_KEY (any long random text). Without it,
// nothing can be sent. Uses the same AIRTABLE_PERSONAL_ACCESS_TOKEN and RESEND_API_KEY as the RSVP.

const AIRTABLE_BASE_ID = "app3DdTXYXOPuzs0V";
const RSVP_TABLE = "RSVP";
const AIRTABLE_API = process.env.AIRTABLE_API_URL || "https://api.airtable.com";
const RESEND_API = process.env.RESEND_API_URL || "https://api.resend.com";

const FROM = "Koko at PlayLane <helloneighbour@playlane.co>";
const SUBJECT = "Tonight, we’re on the Lane";
const SEND_ID = "watchlane-rye-lane-2026-10-31"; // stops the same guest getting this twice
const IMG = "https://playlane.co/images/email";
const GET_READY_URL =
  "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("Cortland Broad Street, Broad Street, Birmingham");

function esc(t) {
  return String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function listGuestEmails() {
  const emails = new Map(); // lower-case → as typed
  let offset = "";
  do {
    const url = `${AIRTABLE_API}/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(RSVP_TABLE)}?pageSize=100&fields%5B%5D=Email` +
      (offset ? "&offset=" + encodeURIComponent(offset) : "");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN}` } });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Airtable HTTP ${res.status}: ${JSON.stringify(data)}`);
    for (const r of data.records || []) {
      const e = String((r.fields && r.fields.Email) || "").trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !emails.has(e.toLowerCase())) emails.set(e.toLowerCase(), e);
    }
    offset = data.offset || "";
  } while (offset);
  return [...emails.values()];
}

// Resend batch send: up to 100 emails in one request. The idempotency key means pressing
// "send" again within 24 hours doesn't send the same batch twice.
async function sendBatch(recipients, idempotencyKey) {
  const res = await fetch(`${RESEND_API}/emails/batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(recipients.map(to => ({ from: FROM, to: [to], subject: SUBJECT, html: emailHTML(), text: emailText() }))),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;background:#f1ede2;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#151412}
.top{max-width:640px;margin:0 auto;padding:20px 16px}
h1{font-size:22px;margin:0 0 6px}p{line-height:1.5;margin:8px 0}
.box{background:#fff;border:2px solid #151412;padding:16px;margin:14px 0}
input{font:inherit;padding:10px;border:2px solid #151412;width:100%;box-sizing:border-box;margin:6px 0 10px}
button{font:inherit;font-weight:700;padding:12px 16px;border:2px solid #151412;background:#fff69a;cursor:pointer;width:100%}
button.go{background:#151412;color:#fff69a}
.ok{background:#e4f6df}.bad{background:#fbe1dc}
iframe{display:block;width:100%;max-width:640px;margin:0 auto 40px;height:2400px;border:0;background:#fff}</style></head>
<body><div class="top">${body}</div></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const url = new URL(req.url, "https://playlane.co");
  const key = url.searchParams.get("key") || "";

  if (!process.env.BROADCAST_KEY) {
    return res.status(503).send(page("Not set up", "<h1>Not set up yet</h1><p>Add <b>BROADCAST_KEY</b> in Vercel → Settings → Environment Variables, then redeploy.</p>"));
  }
  if (key !== process.env.BROADCAST_KEY) {
    return res.status(403).send(page("Not allowed", "<h1>Not allowed</h1><p>This link needs the right key.</p>"));
  }
  if (url.searchParams.get("view") === "email") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(emailHTML());
  }

  const k = encodeURIComponent(key);
  try {
    if (req.method === "POST") {
      const test = (url.searchParams.get("test") || "").trim();
      if (test) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(test)) return res.status(400).send(page("Check the email", `<h1>That email doesn't look right</h1><p><a href="?key=${k}">Back</a></p>`));
        const r = await sendBatch([test], `${SEND_ID}-test-${test.toLowerCase()}-${Date.now()}`);
        return res.status(r.ok ? 200 : 500).send(page("Test", `<div class="box ${r.ok ? "ok" : "bad"}"><h1>${r.ok ? "Test sent" : "Test failed"}</h1><p>${r.ok ? `Check ${esc(test)} (and Promotions/spam).` : esc(JSON.stringify(r.data))}</p></div><p><a href="?key=${k}">Back</a></p>`));
      }
      const guests = await listGuestEmails();
      if (!guests.length) return res.status(200).send(page("No guests", `<h1>No guests on the RSVP list</h1><p><a href="?key=${k}">Back</a></p>`));
      // One fixed key: once the full send has gone, pressing send again sends nothing
      const r = await sendBatch(guests, SEND_ID);
      if (r.status === 409) {
        return res.status(200).send(page("Already sent", `<div class="box ok"><h1>Already sent ✓</h1><p>This email has already gone to the guest list, so nothing was sent again.</p></div>`));
      }
      console.log(`[tonight] Batch to ${guests.length} guests: ${r.ok ? "sent" : "FAILED " + JSON.stringify(r.data)}`);
      return res.status(r.ok ? 200 : 500).send(page("Sent", `<div class="box ${r.ok ? "ok" : "bad"}"><h1>${r.ok ? `Sent to ${guests.length} guest${guests.length === 1 ? "" : "s"} ✓` : "Sending failed"}</h1><p>${r.ok ? "Everyone on the RSVP list has been emailed. Pressing send again won’t email them twice." : esc(JSON.stringify(r.data))}</p></div>`));
    }

    const guests = await listGuestEmails();
    return res.status(200).send(page("Tonight email", `
<h1>“Tonight, we’re on the Lane”</h1>
<p>From <b>${esc(FROM)}</b> · Subject <b>${esc(SUBJECT)}</b></p>
<div class="box"><b>1. Send yourself a test</b>
<form method="post" action="?key=${k}" onsubmit="this.action='?key=${k}&test='+encodeURIComponent(this.t.value)">
<input name="t" type="email" placeholder="your@email.com" required><button type="submit">Send me a test</button></form></div>
<div class="box"><b>2. Send to everyone</b><p>This goes to <b>${guests.length} guest${guests.length === 1 ? "" : "s"}</b> on the RSVP list.</p>
<form method="post" action="?key=${k}" onsubmit="return confirm('Send to ${guests.length} guests now?')"><button class="go" type="submit">Send to ${guests.length} guests</button></form></div>
<p>Preview:</p></div><iframe src="?key=${k}&view=email" title="Email preview"></iframe><div>`));
  } catch (err) {
    console.error("[tonight] error:", err);
    return res.status(500).send(page("Error", `<div class="box bad"><h1>Something went wrong</h1><p>${esc(err.message || err)}</p></div>`));
  }
}

// ─── The email ────────────────────────────────────────────────────────────

const STEPS = [
  ["clock", "ARRIVAL · 6–7PM", "Come in, get comfy and help yourself to the pre-screening nibbles. Pour a drink, say hi and make yourself at home."],
  ["blanket", "BLANKET REVEAL", "This is the moment. I want to see the throw blanket you brought — and yes, we’ll be capturing it. So come with something cosy, fun or totally you. I know you’ll deliver. 👀"],
  ["clapper", "MOVIE STARTS · 7PM SHARP", "We’re watching <em>Rye Lane</em> (1 hour 22 minutes). Please grab your snacks and drinks before the film begins. And yes, refills are absolutely encouraged. Nobody’s rationing popcorn here. 😏"],
  ["camera", "CAMERAS ON", "We’ll be capturing little moments throughout the evening — blanket reveals, reactions, the vibes. If you’d rather not be photographed, just let Osaro know."],
  ["music", "AFTER THE MOVIE?", "We play the night away. The night is ours to make. Chat, laugh, dance and keep the good vibes going."],
  ["sparkle", "DRESS CODE", "Relaxed with a spark. So… I’m expecting to see you looking cool with a swag. 😎 Pyjamas and heels? Absolutely."],
];

function emailText() {
  return [
    "TONIGHT, WE’RE ON THE LANE.",
    "",
    "Heyyy you!",
    "",
    "Koko’s WatchLane is happening tonight and I can’t wait to see you.",
    "",
    "It’s an intimate evening (less than 15 of us), and the vibe is simple: come as you are, bring your throw blanket, look good, be open and ready to have a proper good time.",
    "",
    "YOUR GUIDE TO TONIGHT",
    "",
    ...STEPS.flatMap(([, t, b]) => [t, b.replace(/<[^>]+>/g, ""), ""]),
    "See you on the Lane,",
    "Koko ♡",
    "",
    `Get ready: ${GET_READY_URL}`,
  ].join("\n");
}

function emailHTML() {
  const Y = "#fff69a", R = "#f4502e", INK = "#151412";
  const serif = "Georgia,'Times New Roman',serif";
  const mono = "'Courier New',Courier,monospace";
  const grot = "'Arial Black','Helvetica Neue',Arial,sans-serif";
  const step = ([icon, title, body], i) => `
<tr><td style="border-top:${i ? "1px" : "0"} solid ${INK};padding:16px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="84" valign="middle" style="width:84px;padding-right:14px"><img src="${IMG}/tonight/icon-${icon}.png" width="70" height="70" alt="" style="display:block;border:0;width:70px;height:70px"></td>
<td valign="middle" style="border-left:2px solid ${INK};padding-left:18px">
<div style="font-family:${grot};font-weight:900;font-size:17px;letter-spacing:1px;color:${R};margin:0 0 4px">${title}</div>
<div style="font-family:${serif};font-size:16px;line-height:1.5;color:${INK}">${body}</div>
</td></tr></table></td></tr>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Tonight, we’re on the Lane</title>
<style>
@media (max-width:600px){
 .shell{width:100%!important}
 .pad{padding-left:20px!important;padding-right:20px!important}
 .col{display:block!important;width:100%!important;padding:0!important}
 .poster{padding:22px 0 0!important;text-align:center!important}
 .poster img{margin:0 auto!important}
 .h1{font-size:50px!important}
 .foot-l,.foot-r{display:block!important;width:100%!important;border:0!important;padding:0!important;text-align:left!important}
 .foot-r{padding-top:22px!important}
}
</style></head>
<body style="margin:0;padding:0;background:#ece6c9">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Koko’s WatchLane is happening tonight. Here’s your guide to the evening.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ece6c9"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" class="shell" width="620" cellpadding="0" cellspacing="0" style="width:620px;max-width:100%;background:${Y}">

<tr><td class="pad" style="padding:28px 36px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td valign="top"><img src="${IMG}/wordmark.png" width="170" height="25" alt="PLAYLANE" style="display:block;border:0;width:170px;height:25px"></td>
<td valign="top" align="right" style="font-family:${mono};font-size:10px;line-height:1.8;letter-spacing:2px;color:${INK}">PEOPLE<br>FILMS<br>CONVERSATIONS<div style="width:26px;height:2px;background:${INK};margin:6px 0 0 auto"></div></td>
</tr></table></td></tr>

<tr><td class="pad" style="padding:18px 36px 26px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td class="col" valign="top" style="padding-right:18px">
 <div class="h1" style="font-family:${grot};font-weight:900;font-size:62px;line-height:.92;letter-spacing:-3px;color:${R}">Tonight, we’re on the Lane.</div>
 <img src="${IMG}/tonight/heart.png" width="40" height="49" alt="" style="display:block;border:0;width:40px;height:49px;margin:6px 0 0 auto">
 <p style="font-family:${serif};font-size:19px;line-height:1.45;color:${INK};margin:0 0 12px">Heyyy you!</p>
 <p style="font-family:${serif};font-size:19px;line-height:1.45;color:${INK};margin:0 0 12px">Koko’s WatchLane is happening tonight and I can’t wait to see you.</p>
 <p style="font-family:${serif};font-size:19px;line-height:1.45;color:${INK};margin:0">It’s an intimate evening (less than 15 of us), and the vibe is simple: come as you are, bring your throw blanket, look good, be open and ready to have a proper good time.</p>
</td>
<td class="col poster" valign="top" width="210" style="width:210px;padding-top:62px">
 <img src="${IMG}/tonight/poster.jpg" width="210" height="444" alt="Rye Lane" style="display:block;border:0;width:210px;height:auto">
</td></tr></table></td></tr>

<tr><td class="pad" style="padding:0 36px">
<div style="border-top:2px solid ${INK};border-bottom:2px solid ${INK};padding:12px 0;font-family:${mono};font-weight:bold;font-size:17px;letter-spacing:4px;color:${INK}">YOUR GUIDE TO TONIGHT</div>
</td></tr>

<tr><td class="pad" style="padding:0 36px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${STEPS.map(step).join("")}</table>
</td></tr>

<tr><td class="pad" style="background:#060606;padding:26px 36px 30px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td class="foot-l" valign="middle" width="50%" style="width:50%;border-right:1px solid ${Y};padding-right:20px">
 <img src="${IMG}/tonight/signoff.png" width="210" height="127" alt="See you on the Lane, Koko ♡" style="display:block;border:0;width:210px;height:auto">
</td>
<td class="foot-r" valign="middle" align="right" style="padding-left:20px">
 <table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table"><tr><td style="background:${Y};padding:16px 26px">
 <a href="${GET_READY_URL}" target="_blank" style="font-family:${mono};font-weight:bold;font-size:16px;letter-spacing:3px;color:${INK};text-decoration:none">GET READY &nbsp;&#8599;&#xFE0E;</a>
 </td></tr></table>
</td></tr></table>
</td></tr>

</table></td></tr></table></body></html>`;
}
