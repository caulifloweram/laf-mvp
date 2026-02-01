#!/usr/bin/env node
/**
 * Musical Expert: discover online radios from Are.na by searching for radio-related
 * channels and aggregating all link blocks. Outputs a list for the project owner to deploy.
 *
 * Usage: node scripts/discover-are-na-radios.mjs [output.json]
 * Default output: scripts/are-na-radios-discovered.json
 *
 * Uses: GET /v2/search/channels?q=... then GET /v2/channels/:slug/contents for each channel.
 */

import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = "https://api.are.na/v2";
const OUTPUT = process.argv[2] || join(__dirname, "are-na-radios-discovered.json");

// Search queries to find channels that likely contain online radio links
const SEARCH_QUERIES = [
  "online radio",
  "internet radio",
  "web radio",
  "community radio",
  "radio stream",
  "radio fm",
  "radio station",
  "freeform radio",
  "college radio",
  "pirate radio",
  "online radios",
  "radio online",
  "streaming radio",
  "radio 24/7",
  "radio live",
  "independent radio",
  "artist radio",
  "radio art",
  "sound art radio",
  "experimental radio",
  "radio berlin",
  "radio london",
  "radio nyc",
  "radio paris",
  "nts radio",
  "dublab",
  "radio list",
  "radio stations",
  "listen radio",
  "radio broadcast",
  "fm radio",
  "digital radio",
  "radio mix",
  "dj radio",
  "radio show",
  "radio residency",
  "radio platform",
  "radio project",
  "radio collective",
  "radio station list",
  "best online radio",
  "curated radio",
  "radio curation",
  "radio links",
  "radio resources",
];

// Domains to skip (social, aggregators, non-radio)
const SKIP_DOMAINS = new Set([
  "are.na",
  "twitter.com",
  "x.com",
  "instagram.com",
  "facebook.com",
  "twitch.tv",
  "soundcloud.com",
  "youtube.com",
  "youtu.be",
  "spotify.com",
  "apple.com",
  "apps.apple.com",
  "play.google.com",
  "radio.garden",
  "accuradio.com",
  "181.fm",
  "discord.com",
  "t.co",
  "monoskop.org",
  "bandcamp.com",
  "mixcloud.com",
  "residentadvisor.net",
  "discogs.com",
  "wikipedia.org",
  "wikimedia.org",
  "github.com",
  "vimeo.com",
  "tiktok.com",
  "linkedin.com",
  "reddit.com",
  "medium.com",
  "substack.com",
  "patreon.com",
  "ko-fi.com",
  "paypal.com",
  "goo.gl",
  "bit.ly",
  "tinyurl.com",
]);

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function shouldSkipLink(url) {
  const domain = domainFromUrl(url);
  if (SKIP_DOMAINS.has(domain)) return true;
  if (domain.includes("are.na")) return true;
  if (/\/archive\/|\/playlists\/|\/shows\/|\/p\/|\/track\/|\/album\//i.test(url)) return true;
  return false;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "LAF-MVP-MusicalExpert/1.0 (https://github.com/caulifloweram/laf-mvp)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function searchChannels(query, page = 1, per = 50) {
  const q = encodeURIComponent(query);
  const url = `${BASE}/search/channels?q=${q}&page=${page}&per=${per}`;
  return fetchJson(url);
}

async function fetchChannelContents(slug, page = 1, per = 100) {
  const url = `${BASE}/channels/${slug}/contents?page=${page}&per=${per}`;
  return fetchJson(url);
}

async function getAllContents(slug) {
  const blocks = [];
  let page = 1;
  while (true) {
    const data = await fetchChannelContents(slug, page, 100);
    const contents = Array.isArray(data) ? data : (data.contents || []);
    if (!contents.length) break;
    blocks.push(...contents);
    if (contents.length < 100) break;
    page++;
  }
  return blocks;
}

function extractLinks(blocks) {
  return blocks
    .map((b) => ({
      title: b.title || null,
      description: b.description || null,
      url: b.source?.url || b.source_url || b.url,
      id: b.id,
      class: b.class,
    }))
    .filter((x) => x.url && typeof x.url === "string");
}

async function main() {
  const seenSlugs = new Set();
  const seenUrls = new Map(); // normalized URL -> { link, sourceChannel }
  const channelsSearched = [];
  const channelSlugsFetched = [];

  // 1) Search for channels with each query
  console.error("Searching Are.na for radio-related channels...");
  for (const query of SEARCH_QUERIES) {
    try {
      const data = await searchChannels(query, 1, 50);
      const channels = data.channels || [];
      channelsSearched.push({ query, count: channels.length });
      for (const ch of channels) {
        const slug = ch.slug || ch.id?.toString();
        if (!slug || seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);
        channelSlugsFetched.push({
          slug,
          title: ch.title || null,
          length: ch.length ?? 0,
          query,
        });
      }
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      console.error(`  Search "${query}" failed:`, e.message);
    }
  }

  console.error(`Found ${channelSlugsFetched.length} unique channels. Fetching contents...`);

  // 2) Fetch contents of each channel and aggregate links
  for (let i = 0; i < channelSlugsFetched.length; i++) {
    const { slug, title } = channelSlugsFetched[i];
    try {
      const blocks = await getAllContents(slug);
      const links = extractLinks(blocks);
      for (const link of links) {
        if (shouldSkipLink(link.url)) continue;
        try {
          const u = new URL(link.url);
          const normalized = u.origin.replace(/\/$/, "") + (u.pathname === "/" ? "" : u.pathname);
          if (!seenUrls.has(normalized)) {
            seenUrls.set(normalized, {
              title: link.title,
              description: link.description,
              url: link.url,
              sourceChannel: title || slug,
              sourceSlug: slug,
            });
          }
        } catch (_) {}
      }
      if ((i + 1) % 20 === 0) console.error(`  Fetched ${i + 1}/${channelSlugsFetched.length} channels, ${seenUrls.size} unique links so far`);
      await new Promise((r) => setTimeout(r, 350));
    } catch (e) {
      console.error(`  Channel ${slug} failed:`, e.message);
    }
  }

  const links = [...seenUrls.values()];
  const out = {
    _comment: "Discovered by Musical Expert from Are.na search. For project owner: use with resolve-are-na-streams.mjs or API resolve to get stream URLs, then add to EXTERNAL_STATION_CONFIGS or external_stations.",
    discoveredAt: new Date().toISOString(),
    searchQueries: SEARCH_QUERIES.length,
    channelsSearched,
    channelSlugsFetched: channelSlugsFetched.length,
    uniqueLinkCount: links.length,
    links,
  };

  writeFileSync(OUTPUT, JSON.stringify(out, null, 2), "utf8");
  console.error(`Wrote ${links.length} unique links from ${channelSlugsFetched.length} channels to ${OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
