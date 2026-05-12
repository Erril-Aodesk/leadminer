const https = require("https");
const http  = require("http");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
];

function randUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function fetchURL(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const options = {
      headers: {
        "User-Agent": randUA(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-AU,en-GB;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "Connection": "keep-alive",
      },
      timeout: 25000,
    };

    const req = lib.get(url, options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchURL(res.headers.location, attempt));
      }
      if ([403, 429, 503].includes(res.statusCode) && attempt < 2) {
        return setTimeout(() => resolve(fetchURL(url, attempt + 1)), (attempt + 1) * 3000);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from yellowpages.com.au`));
      }

      let stream = res;
      const enc = res.headers["content-encoding"];
      if (enc === "gzip") {
        const zlib = require("zlib");
        stream = res.pipe(zlib.createGunzip());
      } else if (enc === "br") {
        const zlib = require("zlib");
        stream = res.pipe(zlib.createBrotliDecompress());
      } else if (enc === "deflate") {
        const zlib = require("zlib");
        stream = res.pipe(zlib.createInflate());
      }

      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stream.on("error", reject);
    });

    req.on("error", err => {
      if (attempt < 2) setTimeout(() => resolve(fetchURL(url, attempt + 1)), 2000);
      else reject(err);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

function parseListings(html, fields) {
  const leads = [];
  const stripTags = s => s ? s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";

  let sections = html.split(/(?=<(?:div|li|article)[^>]+(?:class="[^"]*(?:listing-result|search-result|organic|natural)[^"]*"|data-listing-id)[^>]*>)/i);
  if (sections.length < 3) {
    sections = html.split(/(?=<h3[^>]+class="[^"]*listing-name[^"]*")/i);
  }

  for (const sec of sections) {
    if (sec.length < 100) continue;
    if (!sec.includes("listing-name") && !sec.includes("listing-contact") && !sec.includes("tel:")) continue;

    const lead = {};

    if (fields.includes("name")) {
      const m = sec.match(/class="[^"]*listing-name[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,80})/i)
             || sec.match(/<h[23][^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,80})/i);
      lead["Business Name"] = m ? m[1].trim().replace(/&amp;/g,"&").replace(/&#39;/g,"'") : "";
    }

    if (fields.includes("phone")) {
      const m = sec.match(/href="tel:([^"]+)"/i)
             || sec.match(/class="[^"]*(?:phone|contact-number)[^"]*"[^>]*>\s*([0-9()\s\-+]{7,20})/i);
      lead["Phone"] = m ? m[1].replace("tel:","").trim() : "";
    }

    if (fields.includes("website")) {
      const m = sec.match(/href="(https?:\/\/(?!(?:www\.)?yellowpages\.com\.au)[^"]{4,})"[^>]*(?:class="[^"]*(?:website|visit-website|external)[^"]*"|data-event="[^"]*website[^"]*")[^>]*>/i)
             || sec.match(/(?:class="[^"]*website[^"]*"|data-track="website")[^>]*href="(https?:\/\/[^"]+)"/i);
      lead["Website"] = m ? m[1].trim() : "";
    }

    if (fields.includes("address")) {
      const m = sec.match(/class="[^"]*(?:listing-address|address|street)[^"]*"[^>]*>([\s\S]{5,200}?)<\/(?:p|div|span|address)>/i);
      lead["Address"] = m ? stripTags(m[1]) : "";
    }

    if (fields.includes("suburb")) {
      const m = sec.match(/\b([A-Z][a-zA-Z\s]{2,30}),?\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+(\d{4})\b/);
      lead["Suburb/State"] = m ? `${m[1].trim()}, ${m[2]} ${m[3]}` : "";
    }

    if (fields.includes("category")) {
      const m = sec.match(/class="[^"]*(?:categor|business-type)[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,60})/i);
      lead["Category"] = m ? m[1].trim() : "";
    }

    if (fields.includes("email")) {
      const m = sec.match(/href="mailto:([^"?]+)"/i);
      lead["Email"] = m ? m[1].trim() : "";
    }

    if (fields.includes("yp_url")) {
      const m = sec.match(/href="(\/(?:business|listings|find|[a-z0-9-]+\/[a-z0-9-]+)[^"]{3,})"/i);
      lead["YP Listing URL"] = m ? "https://www.yellowpages.com.au" + m[1] : "";
    }

    if (lead["Business Name"] && lead["Business Name"].length > 1) leads.push(lead);
  }

  const seen = new Set();
  return leads.filter(l => {
    const k = l["Business Name"].toLowerCase();
    if (seen.has(k)) return false;
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
  const fields   = body.fields || ["name","phone","website","address","suburb"];

  if (!keyword || !location) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "keyword and location required" }) };
  }

  const allLeads = [], errors = [];

  for (let page = 1; page <= pages; page++) {
    const qs  = new URLSearchParams({ clue: keyword, locationClue: location, pageNumber: page });
    const url = `https://www.yellowpages.com.au/search/listings?${qs}`;
    try {
      const html  = await fetchURL(url);
      const leads = parseListings(html, fields);
      allLeads.push(...leads);
    } catch(e) {
      errors.push(`Page ${page}: ${e.message}`);
    }
    if (page < pages) await sleep(3000 + Math.random() * 2000);
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ leads: allLeads, total: allLeads.length, pages, errors }),
  };
};