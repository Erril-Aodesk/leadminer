const https = require("https");
const http  = require("http");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-AU,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: 20000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchURL(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

function parseListings(html, fields) {
  const leads = [];
  const text = s => s ? s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
  const sections = html.split(/(?=<div[^>]+class="[^"]*(?:listing-result|search-result|organic)[^"]*")/i);

  for (const sec of sections) {
    if (!sec.includes("listing-name") && !sec.includes("business-name")) continue;
    const lead = {};

    if (fields.includes("name")) {
      const m = sec.match(/class="[^"]*listing-name[^"]*"[^>]*>(?:<[^>]+>)*([^<]{2,})/i)
             || sec.match(/<h\d[^>]*>(?:<[^>]+>)*([^<]{3,})<\/[^>]+>/i);
      lead["Business Name"] = m ? m[1].trim() : "";
    }

    if (fields.includes("phone")) {
      const m = sec.match(/href="tel:([^"]+)"/i);
      lead["Phone"] = m ? m[1].replace("tel:", "").trim() : "";
    }

    if (fields.includes("website")) {
      const m = sec.match(/href="(https?:\/\/(?!www\.yellowpages\.com\.au)[^"]+)"[^>]*(?:class="[^"]*(?:website|visit)[^"]*"|rel="nofollow")[^>]*>/i)
             || sec.match(/class="[^"]*website[^"]*"[^>]*href="([^"]+)"/i);
      lead["Website"] = m ? m[1].trim() : "";
    }

    if (fields.includes("address")) {
      const m = sec.match(/class="[^"]*(?:address|location|locality)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|p|address)>/i);
      lead["Address"] = m ? text(m[1]) : "";
    }

    if (fields.includes("suburb")) {
      const m = sec.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),?\s*(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s*\d{4}/);
      lead["Suburb/State"] = m ? m[0].trim() : "";
    }

    if (fields.includes("category")) {
      const m = sec.match(/class="[^"]*categor[^"]*"[^>]*>(?:<[^>]+>)*([^<]{2,})</i);
      lead["Category"] = m ? m[1].trim() : "";
    }

    if (fields.includes("email")) {
      const m = sec.match(/href="mailto:([^"]+)"/i);
      lead["Email"] = m ? m[1].trim() : "";
    }

    if (fields.includes("yp_url")) {
      const m = sec.match(/href="(\/(?:business|listings|find)[^"]+)"/i);
      lead["YP Listing URL"] = m ? "https://www.yellowpages.com.au" + m[1] : "";
    }

    if (lead["Business Name"] && lead["Business Name"].length > 1) {
      leads.push(lead);
    }
  }
  return leads;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const keyword  = (body.keyword  || "").trim();
  const location = (body.location || "").trim();
  const pages    = Math.min(parseInt(body.pages) || 1, 10);
  const fields   = body.fields || ["name","phone","website","address","suburb"];

  if (!keyword || !location) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "keyword and location required" }) };
  }

  const allLeads = [], errors = [];

  for (let page = 1; page <= pages; page++) {
    const qs = new URLSearchParams({ clue: keyword, locationClue: location, pageNumber: page });
    const url = `https://www.yellowpages.com.au/search/listings?${qs}`;
    try {
      const html  = await fetchURL(url);
      const leads = parseListings(html, fields);
      allLeads.push(...leads);
    } catch(e) {
      errors.push(`Page ${page}: ${e.message}`);
    }
    if (page < pages) await sleep(2500 + Math.random() * 1500);
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ leads: allLeads, total: allLeads.length, pages, errors }),
  };
};