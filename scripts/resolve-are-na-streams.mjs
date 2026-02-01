#!/usr/bin/env node
/**
 * Resolve livestream URLs for Are.na channel links and output EXTERNAL_STATION_CONFIGS entries.
 * - Excludes are.na, social (twitter/instagram/facebook/twitch), aggregators, app store, etc.
 * - Dedupes by domain.
 * - Resolves streams via Radio Browser API + manual overrides.
 * Usage: node scripts/resolve-are-na-streams.mjs
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ARE_NA_JSON = join(__dirname, "are-na-links.json");
const RB_API = "https://de1.api.radio-browser.info";

// Domains already in EXTERNAL_STATION_CONFIGS (from main.ts)
const EXISTING_DOMAINS = new Set([
  "refugeworldwide.com", "mutantradio.net", "radio80k.de", "kexp.org", "soma.fm", "wfmu.org",
  "nts.live", "lyl.live", "noodsradio.com", "veneno.live", "kioskradio.com", "kchungradio.org",
  "tikka.live", "wobc.stream", "particle.fm", "hopestradio.community", "netilradio.com",
  "area3000.radio",
]);

// Manual stream URL overrides (website domain -> stream URL or { streamUrl, name? })
const STREAM_OVERRIDES = {
  "manilacommunityradio.live": "https://manilacommunityradio.out.airtime.pro/manilacommunityradio_a",
  "n10.as": "https://n10.as/stream",
  "iso.fm": "https://stream.iso.fm/live",
  "rinse.fm": "https://media.rinse.fm:443/stream",
  "dublab.com": "https://stream.dublab.com/live",
  "worldwidefm.net": "https://worldwidefm.out.airtime.pro/worldwidefm_a",
  "decayfm.com": "https://decayfm.com/stream",
  "worm.org": "https://worm.org/stream/radio-worm",
  "wfmu.org": "http://stream0.wfmu.org/freeform-128k",
  "fip.fr": "https://icecast.radiofrance.fr/fip-midfi.mp3",
  "radarlisboa.fm": "https://radarlisboa.out.airtime.pro/radarlisboa_a",
  "radiostudent.si": "https://stream.radiostudent.si/radiostudent",
  "methodsofmellow.com": "https://stream.methodsofmellow.com/stream",
  "balamii.com": "https://stream.balamii.com/live",
  "radiomushroom.org": "https://radiomushroom.out.airtime.pro/radiomushroom_a",
  "bff.fm": "https://stream.bff.fm/stream",
  "ynotradio.net": "https://stream.ynotradio.net/stream",
  "beatsinspace.net": "https://stream.beatsinspace.net/stream",
  "echobox.radio": "https://echobox.out.airtime.pro/echobox_a",
  "radioradio.radio": "https://stream.radioradio.radio/stream",
  "radio-tnp.com": "https://radio-tnp.out.airtime.pro/radio-tnp_a",
  "pretendradio.club": "https://pretendradio.out.airtime.pro/pretendradio_a",
  "radioamnion.net": "https://radioamnion.out.airtime.pro/radioamnion_a",
  "internetpublicradio.live": "https://internetpublicradio.out.airtime.pro/internetpublicradio_a",
  "friskyradio.com": "https://stream.friskyradio.com/stream",
  "datafruits.fm": "https://stream.datafruits.fm/stream",
  "goodtimesbadtimes.club": "https://goodtimesbadtimes.out.airtime.pro/goodtimesbadtimes_a",
  "montezpress.com": "https://radio.montezpress.com/stream",
  "maydayrooms.org": "https://audio.maydayrooms.org/stream",
  "clubnightclub.com": "https://clubnightclub.out.airtime.pro/clubnightclub_a",
  "publicrecords.tv": "https://publicrecords.out.airtime.pro/publicrecords_a",
  "wax.radio": "https://wax.out.airtime.pro/wax_a",
  "barparttime.com": "https://barparttime.out.airtime.pro/barparttime_a",
  "kchungradio.org": "https://www.kchungradio.org/stream",
  "indiastreetradio.com": "https://indiastreetradio.out.airtime.pro/indiastreetradio_a",
  "thelotradio.com": "https://stream.thelotradio.com/thelotradio",
  "prettyrecs.com": null, // Radio Bonita - no known stream
  "dublab.es": "https://stream.dublab.es/live",
  "oddityradio.fm": "https://oddityradio.out.airtime.pro/oddityradio_a",
  "thelakeradio.com": "https://thelakeradio.out.airtime.pro/thelakeradio_a",
  "gds.fm": "https://stream.gds.fm/gdsfm",
  "food-newyork.com": "https://radio.food-newyork.com/stream",
  "secousse.tv": "https://secousse.out.airtime.pro/secousse_a",
  "vincentradio.com": "https://vincentradio.out.airtime.pro/vincentradio_a",
  "radiorageuses.net": "https://radiorageuses.out.airtime.pro/radiorageuses_a",
  "trnstnradio.com": "https://trnstnradio.out.airtime.pro/trnstnradio_a",
  "idaidaida.net": "https://idaidaida.out.airtime.pro/idaidaida_a",
  "hydefm.com": "https://hydefm.out.airtime.pro/hydefm_a",
  "chirpradio.org": "https://stream.chirpradio.org/chirpradio",
  "lumbungradio.stationofcommons.org": "https://lumbungradio.out.airtime.pro/lumbungradio_a",
  "rtm.fm": "https://rtm.out.airtime.pro/rtm_a",
  "olaradio.fr": "https://olaradio.out.airtime.pro/olaradio_a",
  "oio.studio": null, // art project
  "sutrofm.net": "https://sutrofm.out.airtime.pro/sutrofm_a",
  "lowergrandradio.com": "https://lowergrandradio.out.airtime.pro/lowergrandradio_a",
  "sfsound.org": "https://sfsound.org/stream",
  "movement.radio": "https://movement.out.airtime.pro/movement_a",
  "moonglowradio.net": "https://moonglowradio.out.airtime.pro/moonglowradio_a",
  "tincanradio.co.uk": "https://tincanradio.out.airtime.pro/tincanradio_a",
  "radionopal.com": "https://radionopal.out.airtime.pro/radionopal_a",
  "extra.resonance.fm": "https://stream.resonance.fm/resonance-extra",
  "mountaintown.fm": "https://mountaintown.out.airtime.pro/mountaintown_a",
  "frilo.cool": "https://frilo.cool/stream",
  "terryradio.biz": "https://terryradio.out.airtime.pro/terryradio_a",
  "tsubakifm.com": "https://tsubakifm.out.airtime.pro/tsubakifm_a",
  "automatradio.com": "https://automatradio.out.airtime.pro/automatradio_a",
  "ambientflo.com": "https://ambientflo.out.airtime.pro/ambientflo_a",
  "wobc-fm.org": "https://wobc-fm.org/stream",
  "djfullmoon.com": "https://djfullmoon.out.airtime.pro/djfullmoon_a",
  "radioo.space": "https://radioo.space/stream",
};

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    return url.origin.replace(/\/$/, "") + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    return u;
  }
}

function domainFromUrl(u) {
  try {
    const host = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
    return host;
  } catch {
    return "";
  }
}

const SKIP_DOMAINS = new Set([
  "are.na", "twitter.com", "instagram.com", "facebook.com", "twitch.tv", "soundcloud.com",
  "apps.apple.com", "play.google.com", "radio.garden", "accuradio.com", "181.fm",
  "publicradio.info", "foilmusic.info", "communalradio.club", "undergroundradiodirectory.herokuapp.com",
  "monoskop.org", "yamakan.place", "discord.com", "t.co",
]);

function shouldSkip(link) {
  const url = (link.url || "").toLowerCase();
  const domain = domainFromUrl(url);
  if (SKIP_DOMAINS.has(domain)) return true;
  if (domain.includes("are.na")) return true;
  if (url.includes("/archive/") || url.includes("/playlists/") || url.includes("/shows/") || url.includes("/p/")) return true;
  return false;
}

function pickTitle(link) {
  const t = (link.title || "").trim();
  if (t) return t.replace(/\s*\|\s*.*$/, "").replace(/\s*\(\@.*\)\s*\/\s*Twitter.*$/i, "").trim();
  const d = domainFromUrl(link.url);
  return d.replace(/\.(com|org|fm|net|radio|live)$/, "").replace(/\./g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function radioBrowserSearch(name) {
  const q = encodeURIComponent(name.slice(0, 50));
  const res = await fetch(`${RB_API}/json/stations/search?name=${q}&limit=5`, {
    headers: { "User-Agent": "LAF-MVP/1.0" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data.filter((s) => s.lastcheckok === 1 && (s.url_resolved || s.url)) : [];
}

async function main() {
  const raw = readFileSync(ARE_NA_JSON, "utf8");
  const data = JSON.parse(raw);
  const links = data.links || [];

  const byDomain = new Map();
  for (const link of links) {
    if (!link.url || shouldSkip(link)) continue;
    const domain = domainFromUrl(link.url);
    if (EXISTING_DOMAINS.has(domain)) continue;
    if (!byDomain.has(domain)) {
      let websiteUrl = normalizeUrl(link.url).replace(/^http:\/\//, "https://");
      if (!websiteUrl.endsWith("/") && new URL(websiteUrl).pathname === "/") websiteUrl += "/";
      if (websiteUrl.endsWith("/index.html")) websiteUrl = websiteUrl.replace(/\/index\.html$/, "/");
      byDomain.set(domain, {
        title: pickTitle(link),
        description: (link.description || "").replace(/<[^>]+>/g, "").slice(0, 200) || "",
        websiteUrl,
        domain,
      });
    }
  }

  const configs = [];
  const domains = [...byDomain.keys()];

  for (let i = 0; i < domains.length; i++) {
    const domain = domains[i];
    const meta = byDomain.get(domain);
    let streamUrl = null;

    const override = STREAM_OVERRIDES[domain];
    if (override === null) continue;
    if (typeof override === "string") streamUrl = override;

    if (!streamUrl) {
      const stations = await radioBrowserSearch(meta.title || domain);
      const match = stations.find((s) => {
        const h = (s.homepage || "").toLowerCase();
        return h.includes(domain) || domain.includes(new URL(h).hostname.replace(/^www\./, ""));
      }) || stations[0];
      if (match && (match.url_resolved || match.url)) {
        streamUrl = (match.url_resolved || match.url).trim();
      }
    }

    if (!streamUrl) continue;

    const name = meta.title || domain;
    const description = meta.description || `Online radio from ${domain}.`;
    const logoUrl = `https://${domain}/favicon.ico`;
    configs.push({
      name,
      description,
      websiteUrl: meta.websiteUrl,
      streamUrl,
      logoUrl,
    });
    if ((i + 1) % 10 === 0) console.error(`Resolved ${i + 1}/${domains.length}...`);
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(JSON.stringify(configs, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
