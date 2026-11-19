// api/early-access.js
// Vercel serverless function for the "Get the app" early-access waitlist.
// Saves Name, Email and Location to Airtable. No email is sent yet.
//
// Setup (one time):
//   1. In the same Airtable base as Hosts (app3DdTXYXOPuzs0V), add a table, e.g. "Early Access",
//      with three "Single line text" fields named exactly: Name, Email, Location.
//   2. Optional: in Vercel, set EARLY_ACCESS_TABLE to that table's ID (tbl...) or name.
//      If it isn't set, the table name "Early Access" is used.
//   It reuses AIRTABLE_PERSONAL_ACCESS_TOKEN, which the Host sign-up already uses.

const AIRTABLE_BASE_ID = "app3DdTXYXOPuzs0V";
const TABLE = process.env.EARLY_ACCESS_TABLE || "Early Access";

const SAVE_FAILED_MESSAGE =
  "We couldn't save your details because of a problem on our side. " +
  "Please try again later, or email helloneighbour@playlane.co and we'll add you.";

function formulaString(text) {
  return '"' + String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed", message: "Method not allowed." });
  }

  try {
    const body = req.body || {};
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    const email = typeof body.email === "string" ? body.email.trim().slice(0, 120) : "";
    const location = typeof body.location === "string" ? body.location.trim().slice(0, 80) : "";

    const invalid = (field, message) => res.status(400).json({ error: "invalid", field, message });
    if (!name) return invalid("name", "Please enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return invalid("email", "Please enter a valid email address, like name@example.com.");
    if (!location) return invalid("location", "Please enter your city or town.");

    const token = process.env.AIRTABLE_PERSONAL_ACCESS_TOKEN;
    if (!token) {
      console.error("[early-access] AIRTABLE_PERSONAL_ACCESS_TOKEN is not set in Vercel.");
      return res.status(500).json({ error: "save_failed", message: SAVE_FAILED_MESSAGE });
    }

    const tableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // Already on the list? Treat it as a success so people aren't told off for signing up twice.
    const formula = `LOWER(TRIM({Email} & "")) = ${formulaString(email.toLowerCase())}`;
    const checkRes = await fetch(`${tableUrl}?maxRecords=1&fields%5B%5D=Email&filterByFormula=${encodeURIComponent(formula)}`, { headers });
    if (checkRes.ok) {
      const data = await readJson(checkRes);
      if (data && data.records && data.records.length) {
        return res.status(200).json({ success: true, already: true });
      }
    } else {
      console.error(`[early-access] Duplicate check failed (HTTP ${checkRes.status}). Does the "${TABLE}" table exist with an Email field?`, JSON.stringify(await readJson(checkRes)));
      return res.status(checkRes.status === 429 ? 503 : 500).json({ error: "save_failed", message: SAVE_FAILED_MESSAGE });
    }

    const saveRes = await fetch(tableUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ records: [{ fields: { Name: name, Email: email, Location: location } }] }),
    });
    if (!saveRes.ok) {
      console.error(`[early-access] Saving failed (HTTP ${saveRes.status}). Fields must be Name, Email, Location (single line text).`, JSON.stringify(await readJson(saveRes)));
      return res.status(saveRes.status === 429 ? 503 : 500).json({ error: "save_failed", message: SAVE_FAILED_MESSAGE });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("[early-access] SERVER_ERROR:", error);
    return res.status(500).json({ error: "server_error", message: SAVE_FAILED_MESSAGE });
  }
}
