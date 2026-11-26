// api/hosts-letter.js
// One-off "Stories travel through people" letter from Korede to everyone on the Hosts list,
// plus RSVP guests who ticked "Wants to host". Each person gets it once, even if they're in both.
//
//   GET  /api/hosts-letter?key=…              → preview page: the email + how many hosts it will go to
//   GET  /api/hosts-letter?key=…&view=email   → just the email (shown with the name "Ada")
//   POST /api/hosts-letter?key=…&test=EMAIL   → sends ONE test copy to EMAIL
//   POST /api/hosts-letter?key=…              → sends to every host (each host gets it at most once,
//                                               even if the button is pressed twice)
//
// Uses the same BROADCAST_KEY, AIRTABLE_PERSONAL_ACCESS_TOKEN and RESEND_API_KEY as the other emails.

const AIRTABLE_BASE_ID = "app3DdTXYXOPuzs0V";
const HOSTS_TABLE = "tblqrXUZZcZaStDZO"; // the "Hosts" table (Name, Email, ...)
const RSVP_TABLE = "RSVP"; // only rows with "Wants to host" ticked
const AIRTABLE_API = process.env.AIRTABLE_API_URL || "https://api.airtable.com";
const RESEND_API = process.env.RESEND_API_URL || "https://api.resend.com";

const FROM = "Korede at PlayLane <helloneighbour@playlane.co>";
const SUBJECT = "Stories travel through people";
const SEND_ID = "hosts-letter-stories-2026-11"; // stops the same host getting this twice
const IMG = "https://playlane.co/images/email";

function esc(t) {
  return String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function firstNameOf(name) {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "there";
}

async function readTable(table, formula) {
  const rows = [];
  let offset = "";
  do {
    const url = `${AIRTABLE_API}/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?pageSize=100&fields%5B%5D=Email&fields%5B%5D=Name` +
      (formula ? "&filterByFormula=" + encodeURIComponent(formula) : "") +
      (offset ? "&offset=" + encodeURIComponent(offset) : "");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN}` } });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Airtable (${table}) HTTP ${res.status}: ${JSON.stringify(data)}`);
    rows.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);
  return rows;
}

// Everyone in Hosts, plus RSVP guests who ticked "Wants to host". One entry per email.
async function listHosts() {
  const hosts = new Map(); // lower-case email → { email, firstName }
  const [hostRows, rsvpRows] = await Promise.all([
    readTable(HOSTS_TABLE),
    readTable(RSVP_TABLE, "{Wants to host}"),
  ]);
  for (const r of [...hostRows, ...rsvpRows]) {
    const e = String((r.fields && r.fields.Email) || "").trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !hosts.has(e.toLowerCase())) {
      hosts.set(e.toLowerCase(), { email: e, firstName: firstNameOf(r.fields && r.fields.Name) });
    }
  }
  return [...hosts.values()];
}

// Resend batch send, 100 emails per request. Each chunk has a fixed idempotency key, so pressing
// "send" again within 24 hours doesn't email anyone twice.
async function sendAll(recipients, keyPrefix) {
  let sent = 0;
  for (let i = 0; i < recipients.length; i += 100) {
    const chunk = recipients.slice(i, i + 100);
    const res = await fetch(`${RESEND_API}/emails/batch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `${keyPrefix}-${i / 100}`,
      },
      body: JSON.stringify(chunk.map(h => ({
        from: FROM, to: [h.email], subject: SUBJECT,
        html: emailHTML(esc(h.firstName)), text: emailText(h.firstName),
      }))),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 409) return { ok: true, already: true, sent };
    if (!res.ok) return { ok: false, sent, data };
    sent += chunk.length;
  }
  return { ok: true, sent };
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
iframe{display:block;width:100%;max-width:640px;margin:0 auto 40px;height:3600px;border:0;background:#fff}</style></head>
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
    return res.status(200).send(emailHTML("Ada"));
  }

  const k = encodeURIComponent(key);
  try {
    if (req.method === "POST") {
      const test = (url.searchParams.get("test") || "").trim();
      if (test) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(test)) return res.status(400).send(page("Check the email", `<h1>That email doesn't look right</h1><p><a href="?key=${k}">Back</a></p>`));
        const r = await sendAll([{ email: test, firstName: firstNameOf(url.searchParams.get("name")) }], `${SEND_ID}-test-${Date.now()}`);
        return res.status(r.ok ? 200 : 500).send(page("Test", `<div class="box ${r.ok ? "ok" : "bad"}"><h1>${r.ok ? "Test sent" : "Test failed"}</h1><p>${r.ok ? `Check ${esc(test)} (and Promotions/spam).` : esc(JSON.stringify(r.data))}</p></div><p><a href="?key=${k}">Back</a></p>`));
      }
      const hosts = await listHosts();
      if (!hosts.length) return res.status(200).send(page("No hosts", `<h1>No hosts on the list</h1><p><a href="?key=${k}">Back</a></p>`));
      const r = await sendAll(hosts, SEND_ID);
      console.log(`[hosts-letter] ${hosts.length} hosts: ${r.ok ? (r.already ? "already sent" : "sent") : "FAILED " + JSON.stringify(r.data)}`);
      if (r.already) return res.status(200).send(page("Already sent", `<div class="box ok"><h1>Already sent ✓</h1><p>This letter has already gone out, so nothing was sent again.</p></div>`));
      return res.status(r.ok ? 200 : 500).send(page("Sent", `<div class="box ${r.ok ? "ok" : "bad"}"><h1>${r.ok ? `Sent to ${r.sent} host${r.sent === 1 ? "" : "s"} ✓` : "Sending failed"}</h1><p>${r.ok ? "Everyone on the list has been emailed. Pressing send again won’t email them twice." : `Sent to ${r.sent} before it stopped. ` + esc(JSON.stringify(r.data))}</p></div>`));
    }

    const hosts = await listHosts();
    return res.status(200).send(page("Hosts letter", `
<h1>“Stories travel through people”</h1>
<p>From <b>${esc(FROM)}</b> · Subject <b>${esc(SUBJECT)}</b></p>
<div class="box"><b>1. Send yourself a test</b>
<form method="post" action="?key=${k}" onsubmit="this.action='?key=${k}&test='+encodeURIComponent(this.t.value)+'&name='+encodeURIComponent(this.n.value)">
<input name="n" type="text" placeholder="First name for the greeting, e.g. Korede"><input name="t" type="email" placeholder="your@email.com" required><button type="submit">Send me a test</button></form></div>
<div class="box"><b>2. Send to every host</b><p>This goes to <b>${hosts.length} ${hosts.length === 1 ? "person" : "people"}</b>: everyone on the Hosts list, plus RSVP guests who ticked “Wants to host”. Each person gets it once and is greeted by their first name.</p>
<form method="post" action="?key=${k}" onsubmit="return confirm('Send to ${hosts.length} hosts now?')"><button class="go" type="submit">Send to ${hosts.length} hosts</button></form></div>
<p>Preview:</p></div><iframe src="?key=${k}&view=email" title="Email preview"></iframe><div>`));
  } catch (err) {
    console.error("[hosts-letter] error:", err);
    return res.status(500).send(page("Error", `<div class="box bad"><h1>Something went wrong</h1><p>${esc(err.message || err)}</p></div>`));
  }
}

// ─── The letter ──────────────────────────────────────────────────────────

const LETTER = [
  "Every community begins with a connector. You signed up to become a Host on PlayLane, and there’s something intentional about that decision.",
  "I wanted to reach out personally and, first of all, say thank you for choosing to be part of what we’re building.",
  "Rather than leave you waiting for our next announcement, I thought I’d share a little of what we’re building and, more importantly, get to know you.",
  "We’re at the beginning of building PlayLane, but our belief is simple:<br><strong><em>Stories travel through people.</em></strong>",
  "We’re building a world where your taste in films, the people you bring together and the experiences you create can become something more.",
  "A cinema experience with your own identity.<br>A community built around the stories you love.<br>An opportunity to create value from something you’re genuinely passionate about.",
  "Behind the scenes, we’re developing our film catalogue, building relationships with filmmakers and distributors, and preparing the technology for our first WatchLanes in 2027.",
  "But enough about us for a moment. I’d love to hear a little about you.",
];
const QUESTION = "If you could bring people together around a film tomorrow, what would that experience look like?";
const AFTER = [
  "What kind of films would you love to show? What would the vibe be?",
  "Would you be hosting an existing community, just friends and family, or building an entirely new audience along the way?",
  "Perhaps you already have something in mind, or you’re simply excited about the possibilities.",
  "Either way, I’d love to hear about it. Just reply to this email and tell me a little about what you imagine creating.",
  "You don’t need to have everything figured out. That’s part of what we’re here to help make possible.",
  "Thank you for being here at the beginning.",
];
const PHOTOS = [
  { img: "bar-screening.jpg", w: 1100, h: 825, alt: "Friends talking over drinks at a screening in a bar",
    caption: "A film people thoroughly enjoyed, chit-chat that lit up their faces, and perhaps a few secrets they discovered about people in the neighbourhood." },
  { img: "movie-room.jpg", w: 1024, h: 768, alt: "A small audience in velvet armchairs in a private movie room",
    caption: "A cinematic, immersive experience in a private movie room. Maybe a hotel in your neighbourhood has one." },
  { img: "home-screening.jpg", w: 1100, h: 863, alt: "Friends on a sofa watching a film at home",
    caption: "The comfort of home, a spontaneous hangout with friends, and a movie that wouldn’t let you all stop analysing. 🤣" },
];

function emailText(firstName) {
  const strip = t => t.replace(/<br>/g, "\n").replace(/<[^>]+>/g, "");
  return [
    "STORIES TRAVEL THROUGH PEOPLE.",
    "",
    `Hi ${firstName},`,
    "",
    ...LETTER.flatMap(p => [strip(p), ""]),
    QUESTION,
    "",
    ...AFTER.flatMap(p => [p, ""]),
    "Korede",
    "Founder, PlayLane",
    "",
    "—",
    "",
    ...PHOTOS.flatMap(p => [p.caption, ""]),
    "What will your WatchLane look like?",
  ].join("\n");
}

function emailHTML(firstName) {
  const PAPER = "#f8f4ea", INK = "#1c1a17", SOFT = "#3d3a33", Y = "#fff69a", BAR = "#f2d64b";
  const serif = "Georgia,'Times New Roman',serif";
  const hand = "'Homemade Apple',Georgia,serif";
  const p = t => `<p style="font-family:${serif};font-size:17px;line-height:1.6;color:${SOFT};margin:0 0 16px">${t}</p>`;
  const photo = ph => `
<tr><td class="pad" style="padding:0 44px 30px">
 <img src="${IMG}/hosts/${ph.img}" width="532" alt="${ph.alt}" style="display:block;border:0;width:100%;max-width:532px;height:auto">
 <p style="font-family:${serif};font-style:italic;font-size:16px;line-height:1.5;color:${INK};margin:12px 0 0">${ph.caption}</p>
</td></tr>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Stories travel through people</title>
<link href="https://fonts.googleapis.com/css2?family=Homemade+Apple&display=swap" rel="stylesheet">
<style>
@media (max-width:600px){
 .shell{width:100%!important}
 .pad{padding-left:22px!important;padding-right:22px!important}
 .h1{font-size:40px!important}
 .q{font-size:22px!important}
 .end{font-size:34px!important}
}
</style></head>
<body style="margin:0;padding:0;background:#ebe5d6">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">A personal note from Korede, and one question I’d love you to answer.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ebe5d6"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" class="shell" width="620" cellpadding="0" cellspacing="0" style="width:620px;max-width:100%;background:${PAPER}">

<tr><td class="pad" style="padding:36px 44px 0">
 <img src="${IMG}/wordmark.png" width="150" height="22" alt="PLAYLANE" style="display:block;border:0;width:150px;height:22px">
</td></tr>

<tr><td class="pad" style="padding:30px 44px 0">
 <div class="h1" style="font-family:${serif};font-weight:bold;font-size:48px;line-height:1.05;letter-spacing:-1.5px;color:${INK}">Stories travel through people.</div>
 <div style="width:64px;height:6px;background:${BAR};margin:22px 0 28px"></div>
 <div style="font-family:${hand};font-size:20px;line-height:1.6;color:${INK};margin:0 0 18px">Hi ${firstName},</div>
 ${LETTER.map(p).join("")}
</td></tr>

<tr><td class="pad" style="padding:6px 44px 22px">
 <div class="q" style="font-family:${serif};font-style:italic;font-size:25px;line-height:1.45;color:${INK}"><span style="background:${Y};-webkit-box-decoration-break:clone;box-decoration-break:clone;padding:2px 6px">${QUESTION}</span></div>
</td></tr>

<tr><td class="pad" style="padding:0 44px 6px">
 ${AFTER.map(p).join("")}
</td></tr>

<tr><td class="pad" style="padding:4px 44px 40px">
 <img src="${IMG}/hosts/signature-korede.png" width="147" height="63" alt="Korede" style="display:block;border:0;width:147px;height:63px;margin:0 0 6px">
 <div style="font-family:${serif};font-size:16px;line-height:1.5;color:${INK}">Korede<br>Founder, PlayLane</div>
</td></tr>

<tr><td class="pad" style="padding:0 44px 34px"><div style="border-top:1px solid #d9d1bf;font-size:0;line-height:0">&nbsp;</div></td></tr>

${PHOTOS.map(photo).join("")}

<tr><td class="pad" style="background:${Y};padding:40px 44px 44px">
 <div class="end" style="font-family:${serif};font-style:italic;font-size:42px;line-height:1.1;letter-spacing:-.5px;color:${INK}">what will your<br>watchlane look like?</div>
 <div style="font-family:${serif};font-size:16px;line-height:1.5;color:${SOFT};margin-top:16px">Hit reply and tell me. I read every one.</div>
</td></tr>

</table></td></tr></table></body></html>`;
}
