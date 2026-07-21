// Generates stats.html for consolesforyou.com/stats.html — a live, no-login analytics page.
// Runs in GitHub Actions hourly. Reads Melusi's OWN EU PostHog (project 208594) via the query API,
// filtered to consolesforyou.com (that project is shared with Sawiyya).
// Needs env POSTHOG_API_KEY (a PostHog personal API key with query:read).
// If the key is absent it exits 0 without writing, so the workflow stays green until the secret is added.
import { writeFileSync } from "node:fs";
import { renderHTML } from "./render-stats.mjs";

const KEY = process.env.POSTHOG_API_KEY;
const PROJECT = process.env.POSTHOG_PROJECT_ID || "208594";
const HOST = process.env.POSTHOG_HOST || "https://eu.posthog.com";

if (!KEY) {
  console.log("No POSTHOG_API_KEY set — skipping stats generation (workflow stays green, placeholder page kept).");
  process.exit(0);
}

async function hogql(query) {
  const res = await fetch(`${HOST}/api/projects/${PROJECT}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!res.ok) throw new Error(`PostHog ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.results || [];
}

const SINCE = "now() - INTERVAL 30 DAY";
const HOSTFILTER = "properties.$host ILIKE '%consolesforyou.com%'";

const totals = (
  await hogql(`
    SELECT
      countIf(event = '$pageview') AS views,
      count(DISTINCT if(event = '$pageview', person_id, NULL)) AS visitors,
      countIf(event = '$pageview' AND properties.$pathname ILIKE '%shop%') AS shop_views
    FROM events
    WHERE ${HOSTFILTER} AND timestamp > ${SINCE}
  `)
)[0] || [0, 0, 0];

const countries = await hogql(`
  SELECT properties.$geoip_country_name AS country,
         properties.$geoip_country_code AS code,
         count() AS views
  FROM events
  WHERE event = '$pageview' AND ${HOSTFILTER} AND timestamp > ${SINCE}
    AND country != '' AND country IS NOT NULL
  GROUP BY country, code
  ORDER BY views DESC
  LIMIT 30
`);

const pages = await hogql(`
  SELECT properties.$pathname AS path, count() AS views
  FROM events
  WHERE event = '$pageview' AND ${HOSTFILTER} AND timestamp > ${SINCE}
    AND path IS NOT NULL AND path != ''
  GROUP BY path
  ORDER BY views DESC
  LIMIT 12
`);

const [views, visitors, shopViews] = totals;
const stamp = new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

const html = renderHTML({ views, visitors, shopViews, countries, pages, stamp });
writeFileSync("stats.html", html);
console.log(`Wrote stats.html — ${views} views, ${visitors} visitors, ${shopViews} shop views, ${countries.length} countries, ${pages.length} pages.`);
