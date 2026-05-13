const https = require("https");
const zlib  = require("zlib");

const ZENROWS_API_KEY = "780567355fbfcda661e405bd0a3a0b249c59c1a2";
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function fetchViaZenRows(targetUrl, attempt = 0) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      apikey: ZENROWS_API_KEY,
      url: targetUrl,
      antibot: "true",
      premium_proxy: "true",
      proxy_country: "au",
    });
    const apiUrl = `https://api.zenrows.com/v1/?${params.toString()}`;

    const req = https.get(apiUrl, { timeout: 25000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchViaZenRows(res.headers.location, attempt));
      }
      if ([429, 503].includes(res.statusCode) && attempt < 3) {
        return setTimeout(() => resolve(fetchViaZenRows(targetUrl, attempt + 1)), (attempt + 1) * 4000);
      }

      const chunks = [];
      let stream = res;
      const enc = (res.headers["content-encoding"] || "").toLowerCase();
      if (enc === "gzip")         stream = res.pipe(zlib.createGunzip());
      else if (enc === "br")      stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());

      stream.on("data", c => chunks.push(c));
      stream.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", reject);
    });

    req.on("error", err => {
      if (attempt < 2) setTimeout(() => resolve(fetchViaZenRows(targetUrl, attempt + 1)), 2000);
      else reject(err);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

function buildURL(keyword, location, page) {
  return `https://www.yellowpages.com.au/search/listings?clue=${encodeURIComponent(keyword)}&locationClue=${encodeURIComponent(location)}&pageNumber=${page}`;
}

function parseListings(html, fields) {
  const leads = [];
  const strip  = s => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const decode = s => s
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  let sections = html.split(/(?=<div[^>]+class="[^"]*(?:listing-result|organic|natural|search-result)[^"]*")/i);
  if (sections.length < 3) {
    sections = html.split(/(?=<div[^>]+class="[^"]*result[^"]*"[^>]*>)/i);
  }

  for (const sec of sections) {
    if (sec.length < 100) continue;
    if (!sec.match(/listing-name|business-name|tel:|listing-contact/i)) continue;

    const lead = {};

    if (fields.includes("name")) {
      const m = sec.match(/class="[^"]*listing-name[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,100})/i)
             || sec.match(/<h[123][^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,100})/i);
      lead["Business Name"] = m ? decode(m[1].trim()) : "";
    }
    if (fields.includes("phone")) {
      const m = sec.match(/href="tel:([^"]+)"/i)
             || sec.match(/class="[^"]*(?:phone|contact-number|listing-phone)[^"]*"[^>]*>\s*([0-9()\s\-+]{7,20})/i);
      lead["Phone"] = m ? decode(m[1].replace("tel:", "").trim()) : "";
    }
    if (fields.includes("website")) {
      const m = sec.match(/href="(https?:\/\/(?!(?:www\.)?yellowpages\.com\.au)[^"]{5,})"[^>]*(?:class="[^"]*(?:website|visit|external|track-visit)[^"]*"|data-[a-z]+=[\"'][^"']*website[^"']*[\"'])/i)
             || sec.match(/(?:class="[^"]*(?:website|visit-website)[^"]*")[^>]*href="(https?:\/\/[^"]+)"/i);
      lead["Website"] = m ? m[1].trim() : "";
    }
    if (fields.includes("address")) {
      const m = sec.match(/class="[^"]*(?:listing-address|address|street-address)[^"]*"[^>]*>([\s\S]{3,300}?)<\/(?:p|div|span|address)>/i)
             || sec.match(/itemprop="streetAddress"[^>]*>([^<]{3,100})</i);
      lead["Address"] = m ? decode(strip(m[1])) : "";
    }
    if (fields.includes("suburb")) {
      const m = sec.match(/\b([A-Z][a-zA-Z '\-]{1,30}),?\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b(?:\s+(\d{4}))?/);
      lead["Suburb/State"] = m ? `${m[1].trim()}, ${m[2]}${m[3] ? " " + m[3] : ""}` : "";
    }
    if (fields.includes("category")) {
      const m = sec.match(/class="[^"]*(?:categor|business-type|listing-category)[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,80})/i);
      lead["Category"] = m ? decode(m[1].trim()) : "";
    }
    if (fields.includes("email")) {
      const m = sec.match(/href="mailto:([^"?&]+)"/i);
      lead["Email"] = m ? m[1].trim() : "";
    }
    if (fields.includes("yp_url")) {
      const m = sec.match(/href="(\/[a-zA-Z0-9][^"?#]{10,})"\s*[^>]*class="[^"]*listing-name/i)
             || sec.match(/class="[^"]*listing-name[^"]*"[^>]*href="(\/[^"?#]{10,})"/i);
      lead["YP Listing URL"] = m ? "https://www.yellowpages.com.au" + m[1] : "";
    }

    if (lead["Business Name"] && lead["Business Name"].length > 1) leads.push(lead);
  }

  const seen = new Set();
  return leads.filter(l => {
    const k = (l["Business Name"] || "").toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
  const fields   = body.fields || ["name", "phone", "website", "address", "suburb"];

  if (!keyword || !location) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "keyword and location required" }) };
  }

  const allLeads = [], errors = [], debugInfo = [];

  for (let page = 1; page <= pages; page++) {
    const url = buildURL(keyword, location, page);
    debugInfo.push(`Page ${page}: fetching via ZenRows → ${url}`);
    try {
      const { status, body: html } = await fetchViaZenRows(url);
      debugInfo.push(`Page ${page}: HTTP ${status}, ${html.length} bytes`);

      if (status === 200 && html.length > 1000) {
        const leads = parseListings(html, fields);
        allLeads.push(...leads);
        debugInfo.push(`Page ${page}: parsed ${leads.length} leads`);
      } else {
        errors.push(`Page ${page}: unexpected status ${status}`);
        debugInfo.push(`Page ${page}: preview → ${html.substring(0, 300)}`);
      }
    } catch (e) {
      errors.push(`Page ${page}: ${e.message}`);
      debugInfo.push(`Page ${page}: error → ${e.message}`);
    }
    if (page < pages) await sleep(1500 + Math.random() * 1000);
  }

  const seen = new Set();
  const uniqueLeads = allLeads.filter(l => {
    const k = (l["Business Name"] || "").toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ leads: uniqueLeads, total: uniqueLeads.length, pages, errors, debug: debugInfo }),
  };
};