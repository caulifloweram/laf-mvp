#!/usr/bin/env node
/**
 * Fetch all blocks/links from an Are.na channel.
 * Usage: node scripts/fetch-are-na-channel.mjs [slug]
 * Default slug: online-radios-zlvblzsstly (from https://www.are.na/chia/online-radios-zlvblzsstly)
 *
 * Outputs JSON with all link blocks (source.url, title, etc.) for scraping into EXTERNAL_STATION_CONFIGS.
 */

const slug = process.argv[2] || "online-radios-zlvblzsstly";
const BASE = "https://api.are.na/v2";

async function fetchChannel(slug, page = 1, per = 100) {
  const url = `${BASE}/channels/${slug}?page=${page}&per=${per}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function fetchChannelContents(slug, page = 1, per = 100) {
  const url = `${BASE}/channels/${slug}/contents?page=${page}&per=${per}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function main() {
  console.error(`Fetching Are.na channel: ${slug}`);
  const allBlocks = [];
  let page = 1;
  let totalExpected = null;

  // Paginate through all contents; use first response for total if available
  while (true) {
    const data = await fetchChannelContents(slug, page, 100);
    const contents = Array.isArray(data) ? data : (data.contents || []);
    if (totalExpected == null && (data.total_pages != null || data.length != null)) {
      totalExpected = data.length ?? (data.total_pages * (data.per || 100));
      console.error(`Channel length from API: ${totalExpected}`);
    }
    if (!contents.length) break;
    allBlocks.push(...contents);
    console.error(`  Page ${page}: got ${contents.length} blocks (total so far: ${allBlocks.length})`);
    // Are.na may return fewer than per (e.g. 99); keep fetching until empty page
    page++;
  }

  // Include any block that has a URL: Link class or source.url / source_url / url
  const links = allBlocks
    .map((b) => ({
      title: b.title || null,
      description: b.description || null,
      url: b.source?.url || b.source_url || b.url,
      id: b.id,
      class: b.class,
    }))
    .filter((x) => x.url && typeof x.url === "string");

  const channelTitle = (await fetchChannel(slug).catch(() => ({}))).title || slug;
  console.log(JSON.stringify({ channel: channelTitle, slug, totalBlocks: allBlocks.length, linkCount: links.length, links }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
