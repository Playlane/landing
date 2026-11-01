// api/thanks.js
// One-off "Thank you for coming" email to everyone on the RSVP list.
//
//   GET  /api/thanks?key=…              → preview page: the email + how many guests it will go to
//   POST /api/thanks?key=…&test=EMAIL   → sends ONE test copy to EMAIL
//   POST /api/thanks?key=…              → sends to every RSVP (each guest gets it at most once,
//                                          even if the button is pressed twice)
//
// Needs the Vercel environment variable BROADCAST_KEY (any long random text). Without it,
// nothing can be sent. Uses the same AIRTABLE_PERSONAL_ACCESS_TOKEN and RESEND_API_KEY as the RSVP.

const AIRTABLE_BASE_ID = "app3DdTXYXOPuzs0V";
const RSVP_TABLE = "RSVP";
const AIRTABLE_API = process.env.AIRTABLE_API_URL || "https://api.airtable.com";
const RESEND_API = process.env.RESEND_API_URL || "https://api.resend.com";

const FROM = "Koko at PlayLane <helloneighbour@playlane.co>";
const SUBJECT = "Thank you for coming to the Lane ♡";
// Which design guests get: "yellow", "poster" or "afterdark"
const DESIGN = "yellow";
const SEND_ID = "watchlane-rye-lane-thanks-2026-11"; // stops the same guest getting this twice
const IMG = "https://playlane.co/images/email";
const HOST_URL = "https://playlane.co/#host";

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
    return res.status(200).send(emailHTML(url.searchParams.get("design") || DESIGN));
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
      console.log(`[thanks] Batch to ${guests.length} guests: ${r.ok ? "sent" : "FAILED " + JSON.stringify(r.data)}`);
      return res.status(r.ok ? 200 : 500).send(page("Sent", `<div class="box ${r.ok ? "ok" : "bad"}"><h1>${r.ok ? `Sent to ${guests.length} guest${guests.length === 1 ? "" : "s"} ✓` : "Sending failed"}</h1><p>${r.ok ? "Everyone on the RSVP list has been emailed. Pressing send again won’t email them twice." : esc(JSON.stringify(r.data))}</p></div>`));
    }

    const guests = await listGuestEmails();
    return res.status(200).send(page("Tonight email", `
<h1>“Thank you for coming to the Lane”</h1>
<p>From <b>${esc(FROM)}</b> · Subject <b>${esc(SUBJECT)}</b></p>
<div class="box"><b>1. Send yourself a test</b>
<form method="post" action="?key=${k}" onsubmit="this.action='?key=${k}&test='+encodeURIComponent(this.t.value)">
<input name="t" type="email" placeholder="your@email.com" required><button type="submit">Send me a test</button></form></div>
<div class="box"><b>2. Send to everyone</b><p>This goes to <b>${guests.length} guest${guests.length === 1 ? "" : "s"}</b> on the RSVP list.</p>
<form method="post" action="?key=${k}" onsubmit="return confirm('Send to ${guests.length} guests now?')"><button class="go" type="submit">Send to ${guests.length} guests</button></form></div>
<p>Preview (guests get <b>${DESIGN}</b>):</p></div><iframe src="?key=${k}&view=email" title="Email preview"></iframe><div>`));
  } catch (err) {
    console.error("[thanks] error:", err);
    return res.status(500).send(page("Error", `<div class="box bad"><h1>Something went wrong</h1><p>${esc(err.message || err)}</p></div>`));
  }
}

// ─── The email ────────────────────────────────────────────────────────────

const INTRO = [
  "Heyyy you!",
  "Thank you for coming to Koko’s WatchLane. Honestly, it was everything I hoped it would be, and that’s down to every single one of you.",
];

const MOMENTS = [
  {
    img: "poster.jpg", w: 640, h: 918, alt: "The What We’re Watching poster",
    label: "THE FILM",
    title: "We did something a little illegal.",
    body: "A romance movie on a Halloween night. And somehow it worked. The blankets showed up and showed out, the reactions to <strong><em>Rye Lane</em></strong> were half the film, and the conversations afterwards? That’s exactly why we do this.",
  },
  {
    img: "drinks.jpg", w: 1100, h: 733, alt: "The Pick your poison drinks menu and bar",
    label: "THE BAR",
    title: "You picked your poison. Or didn’t.",
    body: "Cosmos, mocktails and the usual suspects. Thank you for keeping the bar busy and the glasses full.",
  },
  {
    img: "popcorn.jpg", w: 1100, h: 733, alt: "Two big bowls of popcorn, salted and caramel",
    label: "THE SNACKS",
    title: "Nobody rationed the popcorn.",
    body: "As promised. Sweet, salted, wings, salmon and more. We hope you went home full and happy.",
  },
];

function emailText() {
  return [
    "LAST NIGHT WAS A LOT OF YOU.",
    "",
    ...INTRO.flatMap(p => [p, ""]),
    ...MOMENTS.flatMap(m => [m.title, m.body.replace(/<[^>]+>/g, ""), ""]),
    "ONE SMALL FAVOUR",
    "Hit reply and tell me your favourite moment of the night, or one film you’d want us to watch next. One line is plenty. I read every single one.",
    "",
    "FANCY HOSTING ONE OF THESE YOURSELF?",
    "If last night got you thinking “I could do this for my people”, you can. PlayLane Hosts bring nights like this to their own communities, and earn from the screenings they host.",
    `Become a PlayLane Host: ${HOST_URL}`,
    "",
    "Until the next one. And there will be a next one.",
    "",
    "See you on the Lane,",
    "Koko ♡",
  ].join("\n");
}

function designYellow() {
  const Y = "#fff69a", R = "#f4502e", INK = "#151412", PEACH = "#ffd3a0", FOOT = "#060606";
  const serif = "Georgia,'Times New Roman',serif";
  const mono = "'Courier New',Courier,monospace";
  const grot = "'Arial Black','Helvetica Neue',Arial,sans-serif";
  const para = t => `<p style="font-family:${serif};font-size:19px;line-height:1.5;color:${INK};margin:0 0 14px">${t}</p>`;
  const label = t => `<div style="font-family:${mono};font-weight:bold;font-size:12px;letter-spacing:3px;color:${INK};margin:0 0 8px">${t}</div>`;
  const title = t => `<div style="font-family:${grot};font-weight:900;font-size:26px;line-height:1.05;letter-spacing:-1px;color:${R};margin:0 0 10px">${t}</div>`;
  const body = t => `<div style="font-family:${serif};font-size:17px;line-height:1.55;color:${INK}">${t}</div>`;
  const photo = (m, width) => `<img src="${IMG}/thanks/${m.img}" width="${width}" alt="${m.alt}" style="display:block;border:2px solid ${INK};width:100%;max-width:${width}px;height:auto">`;

  const [film, bar, snacks] = MOMENTS;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Thank you for coming to the Lane</title>
<style>
@media (max-width:600px){
 .shell{width:100%!important}
 .pad{padding-left:20px!important;padding-right:20px!important}
 .col{display:block!important;width:100%!important;padding:0!important}
 .col-gap{padding-top:18px!important}
 .h1{font-size:50px!important}
 .foot-l,.foot-r{display:block!important;width:100%!important;border:0!important;padding:0!important;text-align:left!important}
 .foot-r{padding-top:20px!important}
}
</style></head>
<body style="margin:0;padding:0;background:#ece6c9">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">A romance movie on a Halloween night. We did that. Thank you for coming.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ece6c9"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" class="shell" width="620" cellpadding="0" cellspacing="0" style="width:620px;max-width:100%;background:${Y}">

<tr><td class="pad" style="padding:28px 36px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td valign="top"><img src="${IMG}/wordmark.png" width="170" height="25" alt="PLAYLANE" style="display:block;border:0;width:170px;height:25px"></td>
<td valign="top" align="right" style="font-family:${mono};font-size:10px;line-height:1.8;letter-spacing:2px;color:${INK}">PEOPLE<br>FILMS<br>CONVERSATIONS<div style="width:26px;height:2px;background:${INK};margin:6px 0 0 auto"></div></td>
</tr></table></td></tr>

<tr><td class="pad" style="padding:18px 36px 8px">
 <div class="h1" style="font-family:${grot};font-weight:900;font-size:64px;line-height:.92;letter-spacing:-3px;color:${R}">Last night was a lot of you.</div>
 <img src="${IMG}/tonight/heart.png" width="40" height="49" alt="" style="display:block;border:0;width:40px;height:49px;margin:8px 0 6px auto">
 ${INTRO.map(para).join("")}
</td></tr>

<tr><td class="pad" style="padding:6px 36px 0">
<div style="border-top:2px solid ${INK};border-bottom:2px solid ${INK};padding:12px 0;font-family:${mono};font-weight:bold;font-size:17px;letter-spacing:4px;color:${INK}">HOW THE NIGHT WENT</div>
</td></tr>

<!-- The film: poster beside text -->
<tr><td class="pad" style="padding:26px 36px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid ${INK}"><tr>
<td class="col" valign="top" width="230" style="width:230px;padding:0 22px 26px 0">${photo(film, 230)}</td>
<td class="col col-gap" valign="middle" style="padding-bottom:26px">${label(film.label)}${title(film.title)}${body(film.body)}</td>
</tr></table></td></tr>

<!-- The bar and the snacks: wide photos -->
${[bar, snacks].map(m => `
<tr><td class="pad" style="padding:26px 36px 0">
 ${photo(m, 548)}
 <div style="padding:18px 0 26px;border-bottom:1px solid ${INK}">${label(m.label)}${title(m.title)}${body(m.body)}</div>
</td></tr>`).join("")}

<!-- Favour -->
<tr><td class="pad" style="padding:28px 36px 30px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fdfaf0;border:2px solid ${INK}"><tr>
<td width="78" valign="middle" style="width:78px;padding:18px 0 18px 18px"><img src="${IMG}/tonight/icon-music.png" width="60" height="60" alt="" style="display:block;border:0;width:60px;height:60px"></td>
<td valign="middle" style="padding:18px 20px 18px 16px">
 ${label("ONE SMALL FAVOUR")}
 <div style="font-family:${serif};font-size:17px;line-height:1.5;color:${INK}">Hit reply and tell me your favourite moment of the night, or one film you’d want us to watch next. One line is plenty. I read every single one.</div>
</td></tr></table>
</td></tr>

<!-- Host invite -->
<tr><td class="pad" style="background:${R};padding:34px 36px 36px">
 <div style="font-family:${mono};font-weight:bold;font-size:12px;letter-spacing:3px;color:${Y};margin:0 0 10px">FANCY HOSTING ONE OF THESE YOURSELF?</div>
 <div style="font-family:${grot};font-weight:900;font-size:34px;line-height:1;letter-spacing:-1.5px;color:#fff;margin:0 0 14px">Your people. Your night. Your Lane.</div>
 <div style="font-family:${serif};font-size:17px;line-height:1.55;color:#fff;margin:0 0 22px">If last night got you thinking “I could do this for my people”, you can. PlayLane Hosts bring nights like this to their own communities, and earn from the screenings they host.</div>
 <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${Y};border:2px solid ${INK};padding:15px 22px">
 <a href="${HOST_URL}" target="_blank" style="font-family:${mono};font-weight:bold;font-size:15px;letter-spacing:2px;color:${INK};text-decoration:none">BECOME A PLAYLANE HOST &nbsp;&#8599;&#xFE0E;</a>
 </td></tr></table>
</td></tr>

<!-- Sign-off -->
<tr><td class="pad" style="background:${FOOT};padding:26px 36px 30px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td class="foot-l" valign="middle" width="50%" style="width:50%;border-right:1px solid ${Y};padding-right:20px">
 <img src="${IMG}/tonight/signoff.png" width="210" height="127" alt="See you on the Lane, Koko ♡" style="display:block;border:0;width:210px;height:auto">
</td>
<td class="foot-r" valign="middle" style="padding-left:22px;font-family:${serif};font-size:18px;font-style:italic;line-height:1.45;color:${Y}">
 Until the next one.<br>And there will be a next one.
</td></tr></table>
</td></tr>

</table></td></tr></table></body></html>`;
}

function emailHTML(design = DESIGN) {
  if (design === "poster") return designPoster();
  if (design === "afterdark") return designAfterDark();
  return designYellow();
}

// Shared bits for the two extra designs
const RESPONSIVE = `<style>
@media (max-width:600px){
 .shell{width:100%!important}
 .pad{padding-left:20px!important;padding-right:20px!important}
 .col{display:block!important;width:100%!important;padding:0!important}
 .col-gap{padding-top:18px!important}
 .h1{font-size:46px!important}
}
</style>`;
const FAVOUR = "Hit reply and tell me your favourite moment of the night, or one film you’d want us to watch next. One line is plenty. I read every single one.";
const HOST_COPY = "If last night got you thinking “I could do this for my people”, you can. PlayLane Hosts bring nights like this to their own communities, and earn from the screenings they host.";

// ─── Design B: "The Poster" ─ cream paper, black serif, red band, numbered like the night's posters
function designPoster() {
  const PAPER = "#f3ebdc", INK = "#151412", R = "#e3361f";
  const serif = "Georgia,'Times New Roman',serif";
  const mono = "'Courier New',Courier,monospace";
  const num = n => `<div style="font-family:${serif};font-weight:bold;font-size:44px;line-height:1;color:${R};margin:0 0 6px">0${n}</div>`;
  const ttl = t => `<div style="font-family:${serif};font-weight:bold;font-size:24px;line-height:1.15;color:${INK};margin:0 0 8px">${t}</div>`;
  const txt = t => `<div style="font-family:${serif};font-size:16px;line-height:1.55;color:${INK}">${t}</div>`;
  const img = (m, w) => `<img src="${IMG}/thanks/${m.img}" width="${w}" alt="${m.alt}" style="display:block;border:0;width:100%;max-width:${w}px;height:auto">`;
  const [film, bar, snacks] = MOMENTS;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Thank you for coming to the Lane</title>${RESPONSIVE}</head>
<body style="margin:0;padding:0;background:#d9cfbd">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">A romance movie on a Halloween night. We did that. Thank you for coming.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#d9cfbd"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" class="shell" width="620" cellpadding="0" cellspacing="0" style="width:620px;max-width:100%;background:${PAPER}"><tr><td style="padding:12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${INK}">

<tr><td class="pad" style="padding:16px 24px;border-bottom:1px solid ${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-family:${mono};font-size:11px;letter-spacing:3px;color:${INK}">KOKO’S WATCHLANE</td>
<td align="right" style="font-family:${mono};font-size:11px;letter-spacing:3px;color:${INK}">A THANK YOU NOTE</td>
</tr></table></td></tr>

<tr><td style="background:${R};padding:36px 28px 34px" class="pad">
 <div class="h1" style="font-family:${serif};font-weight:bold;font-size:60px;line-height:.95;letter-spacing:-2px;color:${INK}">Last night was a lot of you.</div>
 <div style="font-family:${serif};font-style:italic;font-size:19px;line-height:1.4;color:${PAPER};margin-top:16px">A romance movie on a Halloween night. We did that.</div>
</td></tr>

<tr><td class="pad" style="padding:28px 28px 8px">
 ${INTRO.map(p => `<p style="font-family:${serif};font-size:18px;line-height:1.55;color:${INK};margin:0 0 14px">${p}</p>`).join("")}
</td></tr>

<tr><td class="pad" style="padding:8px 28px 0">
<div style="border-top:1px solid ${INK};padding:14px 0 0;font-family:${mono};font-size:11px;letter-spacing:3px;color:${INK}">HOW THE NIGHT WENT</div>
</td></tr>

<tr><td class="pad" style="padding:18px 28px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td class="col" valign="top" width="250" style="width:250px;padding-right:22px">${img(film, 250)}</td>
<td class="col col-gap" valign="middle">${num(1)}${ttl(film.title)}${txt(film.body)}</td>
</tr></table></td></tr>

<tr><td class="pad" style="padding:26px 28px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${[bar, snacks].map((m, i) => `<td class="col${i ? " col-gap" : ""}" valign="top" width="50%" style="width:50%;${i ? "padding-left:11px" : "padding-right:11px"}">
 ${img(m, 270)}<div style="padding-top:14px">${num(i + 2)}${ttl(m.title)}${txt(m.body)}</div></td>`).join("")}
</tr></table></td></tr>

<tr><td class="pad" style="padding:30px 28px 30px">
<div style="border:1px dashed ${INK};padding:18px 20px">
 <div style="font-family:${mono};font-size:11px;letter-spacing:3px;color:${R};margin:0 0 8px">ONE SMALL FAVOUR</div>
 ${txt(FAVOUR)}
</div></td></tr>

<tr><td class="pad" style="background:${INK};padding:32px 28px 34px">
 <div style="font-family:${mono};font-size:11px;letter-spacing:3px;color:${PAPER};margin:0 0 10px">FANCY HOSTING ONE OF THESE YOURSELF?</div>
 <div style="font-family:${serif};font-weight:bold;font-size:32px;line-height:1.05;color:${PAPER};margin:0 0 12px">Your people. Your night. <em style="color:${R}">Your Lane.</em></div>
 <div style="font-family:${serif};font-size:16px;line-height:1.55;color:${PAPER};margin:0 0 20px">${HOST_COPY}</div>
 <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${R};padding:14px 22px">
 <a href="${HOST_URL}" target="_blank" style="font-family:${mono};font-weight:bold;font-size:14px;letter-spacing:2px;color:${PAPER};text-decoration:none">BECOME A PLAYLANE HOST &nbsp;&#8599;&#xFE0E;</a></td></tr></table>
</td></tr>

<tr><td class="pad" style="padding:26px 28px 18px">
 <div style="font-family:${serif};font-style:italic;font-size:24px;line-height:1.3;color:${INK}">See you on the Lane,<br>Koko <span style="color:${R}">♡</span></div>
 <div style="font-family:${serif};font-size:15px;color:#5a554b;margin-top:8px">Until the next one. And there will be a next one.</div>
</td></tr>

<tr><td align="center" style="padding:6px 24px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="border-top:1px solid ${INK}">&nbsp;</td>
<td width="150" align="center" style="width:150px;padding:0 12px"><img src="${IMG}/wordmark.png" width="120" height="18" alt="PLAYLANE" style="display:block;border:0;width:120px;height:18px"></td>
<td style="border-top:1px solid ${INK}">&nbsp;</td></tr></table></td></tr>

</table></td></tr></table></td></tr></table></body></html>`;
}

// ─── Design C: "After Dark" ─ dark cinema, photos as scenes, ends with a credits roll
function designAfterDark() {
  const BG = "#0f0e0d", CARD = "#1b1a18", CREAM = "#f4ede0", Y = "#fff69a", R = "#f4502e";
  const serif = "Georgia,'Times New Roman',serif";
  const mono = "'Courier New',Courier,monospace";
  const grot = "'Arial Black','Helvetica Neue',Arial,sans-serif";
  const scene = (m, n) => `
<tr><td class="pad" style="padding:30px 36px 0">
 <div style="font-family:${mono};font-size:12px;letter-spacing:3px;color:${Y};margin:0 0 12px">SCENE 0${n} &nbsp;·&nbsp; ${m.label}</div>
 <div style="background:${CARD};padding:10px;border-top:6px dotted #3a3833;border-bottom:6px dotted #3a3833">
 <img src="${IMG}/thanks/${m.img}" width="${n === 1 ? 300 : 528}" alt="${m.alt}" style="display:block;border:0;width:100%;max-width:${n === 1 ? 300 : 528}px;height:auto;margin:0 auto"></div>
 <div style="font-family:${grot};font-weight:900;font-size:25px;line-height:1.05;letter-spacing:-.5px;color:${CREAM};margin:18px 0 8px">${m.title}</div>
 <div style="font-family:${serif};font-size:16px;line-height:1.6;color:#cfc8ba">${m.body}</div>
</td></tr>`;
  const credit = (role, who) => `<tr><td align="right" width="50%" style="width:50%;padding:5px 10px;font-family:${mono};font-size:12px;letter-spacing:2px;color:#a39d90">${role}</td><td style="padding:5px 10px;font-family:${serif};font-size:16px;color:${CREAM}">${who}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>Thank you for coming to the Lane</title>${RESPONSIVE}</head>
<body style="margin:0;padding:0;background:#000">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">A romance movie on a Halloween night. We did that. Thank you for coming.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" class="shell" width="620" cellpadding="0" cellspacing="0" style="width:620px;max-width:100%;background:${BG}">

<tr><td class="pad" style="padding:28px 36px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td><img src="${IMG}/wordmark-yellow.png" width="150" height="22" alt="PLAYLANE" style="display:block;border:0;width:150px;height:22px"></td>
<td align="right" style="font-family:${mono};font-size:11px;letter-spacing:3px;color:#a39d90">THE MORNING AFTER</td>
</tr></table></td></tr>

<tr><td class="pad" style="padding:40px 36px 10px">
 <div class="h1" style="font-family:${grot};font-weight:900;font-size:58px;line-height:.95;letter-spacing:-2.5px;color:${Y}">Thank you for coming to the Lane.</div>
 <div style="width:70px;height:6px;background:${R};margin:24px 0 24px"></div>
 ${INTRO.map(p => `<p style="font-family:${serif};font-size:18px;line-height:1.6;color:${CREAM};margin:0 0 14px">${p}</p>`).join("")}
</td></tr>

${MOMENTS.map((m, i) => scene(m, i + 1)).join("")}

<tr><td class="pad" style="padding:40px 36px 0" align="center">
 <div style="font-family:${mono};font-size:12px;letter-spacing:4px;color:${Y};margin:0 0 14px">— CREDITS —</div>
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
 ${credit("STARRING", "You, in your best throw blanket")}
 ${credit("FILM", "<strong><em>Rye Lane</em></strong>")}
 ${credit("HOSTED BY", "Koko")}
 ${credit("CATERING", "Popcorn, unrationed")}
 ${credit("SOUNDTRACK", "Everyone, after the film")}
 </table>
</td></tr>

<tr><td class="pad" style="padding:34px 36px 0">
<div style="border:1px solid ${Y};padding:18px 20px">
 <div style="font-family:${mono};font-size:12px;letter-spacing:3px;color:${Y};margin:0 0 8px">POST-CREDITS SCENE</div>
 <div style="font-family:${serif};font-size:16px;line-height:1.6;color:${CREAM}">${FAVOUR}</div>
</div></td></tr>

<tr><td class="pad" style="padding:36px 36px 38px">
<div style="background:${Y};padding:28px 24px 26px">
 <div style="font-family:${mono};font-weight:bold;font-size:11px;letter-spacing:3px;color:#151412;margin:0 0 10px">COMING SOON: YOUR OWN SCREENING?</div>
 <div style="font-family:${grot};font-weight:900;font-size:30px;line-height:1;letter-spacing:-1px;color:#151412;margin:0 0 12px">Your people. Your night. Your Lane.</div>
 <div style="font-family:${serif};font-size:16px;line-height:1.55;color:#151412;margin:0 0 20px">${HOST_COPY}</div>
 <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#151412;padding:14px 22px">
 <a href="${HOST_URL}" target="_blank" style="font-family:${mono};font-weight:bold;font-size:14px;letter-spacing:2px;color:${Y};text-decoration:none">BECOME A PLAYLANE HOST &nbsp;&#8599;&#xFE0E;</a></td></tr></table>
</div></td></tr>

<tr><td class="pad" align="center" style="background:#060606;padding:28px 36px 32px">
 <img src="${IMG}/tonight/signoff.png" width="200" height="121" alt="See you on the Lane, Koko ♡" style="display:block;border:0;width:200px;height:auto;margin:0 auto">
 <div style="font-family:${serif};font-style:italic;font-size:16px;color:#a39d90;margin-top:10px">Until the next one. And there will be a next one.</div>
</td></tr>

</table></td></tr></table></body></html>`;
}
