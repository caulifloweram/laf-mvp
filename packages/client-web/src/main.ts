import { OpusDecoder } from "opus-decoder";
import { initRouter, getRoute, type RouteId } from "./router";

let API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
let RELAY_BASE = import.meta.env.VITE_LAF_RELAY_URL || "ws://localhost:9000";
/** Broadcast app URL. Empty = same origin /broadcaster/. Set when client is deployed alone. */
let BROADCASTER_APP_URL = (import.meta.env.VITE_BROADCASTER_APP_URL as string) || "";

function ensureRelayWsUrl(url: string): string {
  const trimmed = url.replace(/\/$/, "");
  if (/^wss?:/i.test(trimmed)) return trimmed;
  return (typeof window !== "undefined" && window.location?.protocol === "https:" ? "wss:" : "ws:") + "//" + trimmed;
}

const CONFIG_FETCH_TIMEOUT_MS = 3000;

async function loadRuntimeConfig(): Promise<void> {
  try {
    const base = window.location.origin;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS);
    const res = await fetch(`${base}/config.json`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return;
    const config = (await res.json()) as { apiUrl?: string; relayWsUrl?: string; broadcasterAppUrl?: string };
    if (config.apiUrl) API_URL = config.apiUrl.replace(/\/$/, "");
    if (config.relayWsUrl) {
      RELAY_BASE = config.relayWsUrl.replace(/\/$/, "");
      if (!/^wss?:/i.test(RELAY_BASE)) {
        RELAY_BASE = (window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + RELAY_BASE;
      }
    }
    if (config.broadcasterAppUrl != null && config.broadcasterAppUrl !== "") BROADCASTER_APP_URL = config.broadcasterAppUrl.replace(/\/$/, "");
  } catch (_) {
    // Use build-time defaults
  }
}

/** Set Broadcast link href from config (same-origin /broadcaster/ or BROADCASTER_APP_URL when client is deployed alone). */
function applyBroadcastLink() {
  const href = BROADCASTER_APP_URL || "/broadcaster/";
  const set = (id: string) => {
    const el = document.getElementById(id);
    if (el && "href" in el) (el as HTMLAnchorElement).href = href;
  };
  set("nav-broadcast");
  set("drawer-broadcast");
}

const MIN_TIER = Number(import.meta.env.VITE_LAF_MIN_TIER || 1);
const MAX_TIER_ALLOWED = Number(import.meta.env.VITE_LAF_MAX_TIER || 4);
const START_TIER = Number(import.meta.env.VITE_LAF_START_TIER || 2);

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000;

interface LAFPacket {
  tier: number;
  flags: number;
  streamId: number;
  seq: number;
  ptsMs: bigint;
  opusPayload: Uint8Array;
}

interface LiveChannel {
  id: string;
  title: string;
  description?: string;
  coverUrl?: string | null;
  streamId: number;
}

/** One playable external stream (single channel). */
interface ExternalStation {
  id?: string;
  name: string;
  description: string;
  websiteUrl: string;
  streamUrl: string;
  logoUrl: string;
}

/** Station config: single stream or multiple channels (e.g. SomaFM). */
interface ExternalStationConfig {
  name: string;
  description: string;
  websiteUrl: string;
  streamUrl: string;
  logoUrl: string;
  /** If set, one card per channel; otherwise one card using streamUrl. */
  channels?: Array<{ name: string; streamUrl: string }>;
}

const EXTERNAL_STATION_CONFIGS: ExternalStationConfig[] = [
  {
    name: "Refuge Worldwide",
    description: "Community radio from Berlin. Music and issues we care about.",
    websiteUrl: "https://refugeworldwide.com/",
    streamUrl: "https://streaming.radio.co/s3699c5e49/listen",
    logoUrl: "https://refugeworldwide.com/apple-touch-icon.png",
  },
  {
    name: "Mutant Radio",
    description: "Independent station streaming worldwide. Experimental, electronic, folk.",
    websiteUrl: "https://www.mutantradio.net/",
    streamUrl: "https://listen.radioking.com/radio/282820/stream/328621",
    logoUrl: "https://www.mutantradio.net/icon?e5faaecf67dfe01a",
  },
  {
    name: "Radio 80000",
    description: "Non-commercial online radio from Munich. Music, dialogue, events.",
    websiteUrl: "https://www.radio80k.de/",
    streamUrl: "https://radio80k.out.airtime.pro:8000/radio80k_a",
    logoUrl: "https://www.radio80k.de/app/uploads/2022/10/cropped-favicon-8000-192x192.gif",
  },
  // From Are.na channel online-radios-zlvblzsstly; stream URLs from Radio Browser API / official sites
  {
    name: "KEXP 90.3 FM",
    description: "Where the Music Matters. Seattle-based listener-supported radio.",
    websiteUrl: "https://www.kexp.org/",
    streamUrl: "https://kexp.streamguys1.com/kexp160.aac",
    logoUrl: "https://www.kexp.org/favicon.ico",
  },
  {
    name: "SomaFM",
    description: "Listener-supported, commercial-free internet radio. Multiple channels.",
    websiteUrl: "http://soma.fm/",
    streamUrl: "https://ice5.somafm.com/live-128-mp3",
    logoUrl: "https://somafm.com/img/somafm-logo-square.png",
    channels: [
      { name: "Groove Salad", streamUrl: "https://ice5.somafm.com/groovesalad-128-mp3" },
      { name: "Drone Zone", streamUrl: "https://ice5.somafm.com/dronezone-128-mp3" },
      { name: "Space Station Soma", streamUrl: "https://ice5.somafm.com/spacestation-128-mp3" },
      { name: "Lush", streamUrl: "https://ice5.somafm.com/lush-128-mp3" },
      { name: "Def Con", streamUrl: "https://ice5.somafm.com/defcon-128-mp3" },
      { name: "Covers", streamUrl: "https://ice5.somafm.com/covers-128-mp3" },
      { name: "Indie Pop Rocks", streamUrl: "https://ice5.somafm.com/indiepop-128-mp3" },
      { name: "Live", streamUrl: "https://ice5.somafm.com/live-128-mp3" },
    ],
  },
  {
    name: "WFMU",
    description: "Independent freeform radio. Jersey City 91.1 FM, Hudson Valley 90.1 FM.",
    websiteUrl: "https://www.wfmu.org/",
    streamUrl: "http://stream0.wfmu.org/freeform-128k",
    logoUrl: "https://www.wfmu.org/favicon.ico",
  },
  {
    name: "NTS Radio",
    description: "Don't Assume. Two live channels, 24/7.",
    websiteUrl: "https://www.nts.live/",
    streamUrl: "https://stream-relay-geo.ntslive.net/stream",
    logoUrl: "https://www.nts.live/favicon.ico",
    channels: [
      { name: "Channel 1", streamUrl: "https://stream-relay-geo.ntslive.net/stream" },
      { name: "Channel 2", streamUrl: "https://stream-relay-geo.ntslive.net/stream2" },
    ],
  },
  {
    name: "LYL Radio",
    description: "We're the rest. Independent webradio from Lyon, Paris, Brussels, Marseille.",
    websiteUrl: "https://lyl.live/",
    streamUrl: "https://stream.lyl.live/live",
    logoUrl: "https://lyl.live/favicon.ico",
  },
  {
    name: "Noods Radio",
    description: "Independent radio broadcasting from Bristol. Electronic, experimental, dub.",
    websiteUrl: "https://noodsradio.com/",
    streamUrl: "https://stream.noodsradio.com/stream",
    logoUrl: "https://noodsradio.com/favicon.ico",
  },
  {
    name: "Veneno",
    description: "Radio online vanguarda. São Paulo-based station. New music, electronic, Brazilian, house, techno and more.",
    websiteUrl: "https://veneno.live/",
    streamUrl: "https://veneno.out.airtime.pro/veneno_a",
    logoUrl: "https://veneno.live/wp-content/uploads/2024/02/veneno-v.svg",
  },
  {
    name: "Kiosk Radio",
    description: "24/7 from a wooden kiosk in Brussels' Parc Royal. Eclectic music from DJs and artists.",
    websiteUrl: "https://kioskradio.com/",
    streamUrl: "https://kioskradiobxl.out.airtime.pro/kioskradiobxl_b",
    logoUrl: "https://kioskradio.com/favicon.ico",
  },
  {
    name: "KCHUNG Radio",
    description: "1630 AM Chinatown Los Angeles. Community radio.",
    websiteUrl: "http://kchungradio.org/",
    streamUrl: "http://stream.kchungradio.org:8000/stream",
    logoUrl: "http://kchungradio.org/favicon.ico",
  },
  {
    name: "Tikka Radio",
    description: "Online radio.",
    websiteUrl: "https://tikka.live/",
    streamUrl: "https://stream.tikka.live/live",
    logoUrl: "https://tikka.live/favicon.ico",
  },
  {
    name: "WOBC Chameleon Radio",
    description: "Oberlin College student-run freeform radio. 91.5 FM, 24/7.",
    websiteUrl: "https://wobc.stream/",
    streamUrl: "https://wobc.stream/stream",
    logoUrl: "https://wobc.stream/favicon.ico",
  },
  {
    name: "Particle FM",
    description: "DIY community internet radio based in San Diego. Underrepresented artists, wild tastes.",
    websiteUrl: "https://www.particle.fm/",
    streamUrl: "https://stream.particle.fm/live",
    logoUrl: "https://www.particle.fm/favicon.ico",
  },
  {
    name: "Hope St Radio",
    description: "Community radio and wine bar. Live from 35 Johnston St, Collingwood, Melbourne.",
    websiteUrl: "https://www.hopestradio.community/",
    streamUrl: "https://stream.hopestradio.community/live",
    logoUrl: "https://www.hopestradio.community/favicon.ico",
  },
  {
    name: "Netil Radio",
    description: "Community broadcasting from Hackney, London. Converted shipping container at Netil Market.",
    websiteUrl: "https://netilradio.com/",
    streamUrl: "https://netilradio.out.airtime.pro/netilradio_b",
    logoUrl: "https://netilradio.com/favicon.ico",
  },
  {
    name: "Tsubaki FM",
    description: "Internet radio from Tokyo, Kyoto, Nagoya. Funk, jazz, soul, electronic, disco, world music.",
    websiteUrl: "https://tsubakifm.com/",
    streamUrl: "https://tsubakifm.out.airtime.pro/tsubakifm_a",
    logoUrl: "https://tsubakifm.com/favicon.ico",
  },
  {
    name: "Radio Nopal",
    description: "Community radio. Eclectic sounds and voices.",
    websiteUrl: "https://www.radionopal.com/",
    streamUrl: "https://radionopal.out.airtime.pro/radionopal_a",
    logoUrl: "https://www.radionopal.com/favicon.ico",
  },
  {
    name: "Good Times Bad Times",
    description: "Community radio at Extra Practice. Good times, bad times.",
    websiteUrl: "https://goodtimesbadtimes.club/",
    streamUrl: "https://radio.goodtimesbadtimes.club/radio/8000/radio.mp3",
    logoUrl: "https://goodtimesbadtimes.club/favicon.ico",
  },
  {
    name: "Radio Robida",
    description: "Robida collective radio. Ambient, programme and walkie-talkie channels.",
    websiteUrl: "https://radio.robidacollective.com/",
    streamUrl: "https://radio.robidacollective.com/stream/programme",
    logoUrl: "https://radio.robidacollective.com/favicon.ico",
  },
  {
    name: "Yamakan Palestine",
    description: "Radio from Yamakan. Palestine.",
    websiteUrl: "https://yamakan.place/palestine/",
    streamUrl: "https://yamakan.out.airtime.pro/yamakan_a",
    logoUrl: "https://yamakan.place/favicon.ico",
  },
  {
    name: "Radio Centraal",
    description: "Independent non-commercial FM radio. Antwerp 106.7 FM. Music, poetry, film, culture.",
    websiteUrl: "https://www.radiocentraal.be/",
    streamUrl: "http://streams.movemedia.eu/centraal",
    logoUrl: "https://www.radiocentraal.be/favicon.ico",
  },
  {
    name: "Cashmere Radio",
    description: "Experimental radio station, Berlin. 88.4 FM Berlin, 90.7 Potsdam. Electronic, ambient, experimental.",
    websiteUrl: "https://cashmereradio.com/",
    streamUrl: "https://cashmereradio.out.airtime.pro/cashmereradio_b",
    logoUrl: "https://cashmereradio.com/favicon.ico",
  },
  {
    name: "Radio Campus Brussels",
    description: "Student radio. Brussels 92.1 FM. Jazz, alternative, rock, electronic, folk, hip-hop.",
    websiteUrl: "https://www.radiocampus.be/",
    streamUrl: "https://stream.radiocampus.be/stream",
    logoUrl: "https://www.radiocampus.be/favicon.ico",
  },
  {
    name: "Black Rhino Radio",
    description: "Electronic, reggae, dub, techno, jazz, hip hop. Live radio.",
    websiteUrl: "https://blackrhinoradio.com/",
    streamUrl: "https://blackrhinoradio.out.airtime.pro/blackrhinoradio_a",
    logoUrl: "https://blackrhinoradio.com/favicon.ico",
  },
  {
    name: "Radio Aparat",
    description: "Eclectic online radio from Belgrade. Guitar music, electronics, indie.",
    websiteUrl: "https://radioaparat.rs/",
    streamUrl: "https://stream4.rcast.net/72355/",
    logoUrl: "https://radioaparat.rs/favicon.ico",
  },
  {
    name: "dublab",
    description: "Non-profit listener-powered radio. Los Angeles. Experimental electronica, jazz funk, indie, hip-hop, dub.",
    websiteUrl: "https://www.dublab.com/",
    streamUrl: "https://dublab.out.airtime.pro/dublab_a",
    logoUrl: "https://www.dublab.com/favicon.ico",
  },
  {
    name: "RUKH",
    description: "Non-commercial DIY community radio from Odesa, Ukraine. Alternative and experimental music, subcultures.",
    websiteUrl: "https://rukh.live/",
    streamUrl: "https://rukh.out.airtime.pro/rukh_a",
    logoUrl: "https://rukh.live/favicon.ico",
  },
  {
    name: "Radio Helsinki",
    description: "Community radio. Graz, Austria 92.6 MHz. Independent, non-commercial.",
    websiteUrl: "https://helsinki.at/",
    streamUrl: "https://live.helsinki.at:8088/live160.mp3",
    logoUrl: "https://helsinki.at/favicon.ico",
  },
  {
    name: "HKCR",
    description: "Hong Kong Community Radio. Community platform and independent station. Creators, musicians, artists.",
    websiteUrl: "https://hkcr.live/",
    streamUrl: "https://stream.hkcr.live/stream",
    logoUrl: "https://hkcr.live/favicon.ico",
  },
  {
    name: "Radio AlHara",
    description: "Radio AlHara راديو الحارة. Palestinian community radio from Bethlehem. Solidarity, sonic liberation.",
    websiteUrl: "https://yamakan.place/palestine/",
    streamUrl: "http://n02.radiojar.com/78cxy6wkxtzuv",
    logoUrl: "https://yamakan.place/palestine/favicon.ico",
  },
  {
    name: "The Lake Radio",
    description: "Independent online community radio from Copenhagen. Experimental, alternative, avant-garde music and sound art 24/7.",
    websiteUrl: "https://thelakeradio.com/",
    streamUrl: "http://hyades.shoutca.st:8627/",
    logoUrl: "https://thelakeradio.com/favicon.ico",
  },
];

/** Built-in configs flattened to one entry per playable stream. */
function getBuiltInStationsFlat(): ExternalStation[] {
  const flat: ExternalStation[] = [];
  for (const s of EXTERNAL_STATION_CONFIGS) {
    if (s.channels && s.channels.length > 0) {
      for (const ch of s.channels) {
        flat.push({
          name: `${s.name}: ${ch.name}`,
          description: s.description,
          websiteUrl: s.websiteUrl,
          streamUrl: ch.streamUrl,
          logoUrl: s.logoUrl,
        });
      }
    } else {
      flat.push({
        name: s.name,
        description: s.description,
        websiteUrl: s.websiteUrl,
        streamUrl: s.streamUrl,
        logoUrl: s.logoUrl,
      });
    }
  }
  return flat;
}

/** All stations (built-in + user-submitted from API), sorted A–Z. Filtered by search in render. */
let allExternalStations: ExternalStation[] = (() => {
  const b = getBuiltInStationsFlat();
  b.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return b;
})();
let stationsSearchQuery = "";

/** Admin overrides for any station (built-in or added) keyed by streamUrl. hidden = true means station is removed from the site. */
let stationOverrides: Record<string, { name?: string | null; description?: string | null; websiteUrl?: string | null; logoUrl?: string | null; hidden?: boolean }> = {};

function applyStationOverride<T extends { name?: string; description?: string; websiteUrl?: string; logoUrl?: string }>(
  station: T,
  streamUrl: string
): T {
  const o = stationOverrides[streamUrl];
  if (!o) return station;
  return {
    ...station,
    ...(o.name !== undefined && o.name !== null && { name: o.name }),
    ...(o.description !== undefined && o.description !== null && { description: o.description }),
    ...(o.websiteUrl !== undefined && o.websiteUrl !== null && { websiteUrl: o.websiteUrl }),
    ...(o.logoUrl !== undefined && o.logoUrl !== null && { logoUrl: o.logoUrl }),
  } as T;
}

function getExternalStationsFlat(): ExternalStation[] {
  const q = stationsSearchQuery.trim().toLowerCase();
  if (!q) return allExternalStations;
  return allExternalStations.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      (s.description && s.description.toLowerCase().includes(q))
  );
}

/** All stream URLs (built-in + user) for live checks. */
function getAllStreamUrls(): string[] {
  const set = new Set<string>();
  for (const c of EXTERNAL_STATION_CONFIGS) {
    if (c.channels?.length) {
      c.channels.forEach((ch) => set.add(ch.streamUrl));
    } else {
      set.add(c.streamUrl);
    }
  }
  allExternalStations.forEach((s) => set.add(s.streamUrl));
  return Array.from(set);
}

const EXTERNAL_STATIONS_FETCH_TIMEOUT_MS = 5000;

async function loadExternalStations(): Promise<void> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXTERNAL_STATIONS_FETCH_TIMEOUT_MS);
    const [stationsRes, overridesRes] = await Promise.all([
      fetch(`${API_URL}/api/external-stations`, { signal: controller.signal }),
      fetch(`${API_URL}/api/station-overrides`, { signal: controller.signal }),
    ]);
    clearTimeout(timeoutId);
    const rows = (await stationsRes.json()) as Array<{
      id?: string;
      name: string;
      description?: string | null;
      websiteUrl: string;
      streamUrl: string;
      logoUrl?: string | null;
    }>;
    const overrides = (await overridesRes.json()) as Array<{ streamUrl: string; name?: string | null; description?: string | null; websiteUrl?: string | null; logoUrl?: string | null; hidden?: boolean }>;
    stationOverrides = {};
    for (const o of overrides || []) {
      if (o.streamUrl) stationOverrides[o.streamUrl] = { name: o.name, description: o.description, websiteUrl: o.websiteUrl, logoUrl: o.logoUrl, hidden: !!o.hidden };
    }
    const userStations: ExternalStation[] = (rows || []).map((r) => ({
      id: r.id,
      name: r.name || "Station",
      description: r.description || "",
      websiteUrl: r.websiteUrl || r.streamUrl,
      streamUrl: r.streamUrl,
      logoUrl: r.logoUrl || "",
    }));
    const builtIn = getBuiltInStationsFlat();
    const merged = [...builtIn, ...userStations];
    merged.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    allExternalStations = merged;
  } catch (e) {
    allExternalStations = getBuiltInStationsFlat().slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }
  renderExternalStations();
}

function decodeLAF(buf: ArrayBuffer): LAFPacket | null {
  const view = new DataView(buf);
  let off = 0;

  const magic = view.getUint32(off); off += 4;
  if (magic !== 0x4c414631) return null;
  const version = view.getUint8(off); off += 1;
  if (version !== 1) return null;

  const tier = view.getUint8(off); off += 1;
  const flags = view.getUint16(off); off += 2;
  const streamId = view.getUint32(off); off += 4;
  const seq = view.getUint32(off); off += 4;
  const hi = view.getUint32(off); off += 4;
  const lo = view.getUint32(off); off += 4;
  const ptsMs = (BigInt(hi) << 32n) | BigInt(lo);
  const opusLen = view.getUint16(off); off += 2;

  if (buf.byteLength < off + opusLen) return null;
  const opusPayload = new Uint8Array(buf, off, opusLen);

  return { tier, flags, streamId, seq, ptsMs, opusPayload };
}

class JitterBuffer {
  private readonly targetDelayMs: number;
  private readonly minBufferPackets: number;
  private readonly maxBufferPackets: number; // Prevent memory overflow
  private packets = new Map<number, LAFPacket>();
  private playbackSeq: number | null = null;
  private startPtsMs: bigint | null = null;
  private playbackStartMs: number | null = null;
  private lastPlayedPacket: LAFPacket | null = null; // For packet loss concealment

  lossCount = 0;
  receivedCount = 0;
  lateCount = 0;
  lastSeq: number | null = null;
  bufferMs = 0;

  constructor(targetDelayMs = 1000, minBufferPackets = 30, maxBufferPackets = 100) {
    this.targetDelayMs = targetDelayMs;
    this.minBufferPackets = minBufferPackets; // ~600ms at 20ms per frame - larger initial buffer
    this.maxBufferPackets = maxBufferPackets; // ~2 seconds max buffer to prevent memory overflow
  }

  push(pkt: LAFPacket) {
    // CRITICAL: Prevent buffer overflow by removing old packets if buffer is too large
    if (this.packets.size >= this.maxBufferPackets) {
      // Remove oldest packets (lowest sequence numbers)
      const sortedSeqs = Array.from(this.packets.keys()).sort((a, b) => a - b);
      const packetsToRemove = sortedSeqs.slice(0, sortedSeqs.length - this.maxBufferPackets + 1);
      for (const seq of packetsToRemove) {
        this.packets.delete(seq);
      }
      if (packetsToRemove.length > 0) {
        console.warn(`[Buffer] Overflow: removed ${packetsToRemove.length} old packets (buffer was ${this.packets.size + packetsToRemove.length}, max: ${this.maxBufferPackets})`);
      }
    }
    
    // Also remove packets that are too far behind playback (more than 2 seconds = 100 packets)
    if (this.playbackSeq !== null) {
      const maxAge = 100; // ~2 seconds at 20ms per packet
      const oldestAllowedSeq = this.playbackSeq - maxAge;
      for (const seq of this.packets.keys()) {
        if (seq < oldestAllowedSeq) {
          this.packets.delete(seq);
        }
      }
    }
    
    this.packets.set(pkt.seq, pkt);
    this.receivedCount++;
    this.lastSeq = pkt.seq;

    if (this.startPtsMs == null) {
      this.startPtsMs = pkt.ptsMs;
      // Don't start playback until we have minimum buffer
      this.playbackSeq = pkt.seq;
      // We'll set playbackStartMs when we have enough packets
      console.log(`Jitter buffer initialized: seq=${pkt.seq}, waiting for ${this.minBufferPackets} packets before playback`);
    }

    // Start playback once we have minimum buffer
    if (this.startPtsMs != null && this.playbackStartMs == null && this.packets.size >= this.minBufferPackets) {
      this.playbackStartMs = performance.now() + this.targetDelayMs;
      console.log(`[Buffer] ready: ${this.packets.size} packets, playback starts in ${this.targetDelayMs}ms`);
    }

    this.updateBuffer();
  }

  private updateBuffer() {
    if (this.startPtsMs == null) {
      this.bufferMs = 0;
      return;
    }
    let maxPts: bigint | null = null;
    this.packets.forEach((p) => {
      if (maxPts == null || p.ptsMs > maxPts) maxPts = p.ptsMs;
    });
    if (maxPts == null) {
      this.bufferMs = 0;
      return;
    }
    this.bufferMs = Number(maxPts - this.startPtsMs);
  }

  popForPlayback(nowMs: number): LAFPacket | null {
    if (
      this.playbackSeq == null ||
      this.playbackStartMs == null ||
      this.startPtsMs == null
    ) {
      return null;
    }
    
    const elapsed = nowMs - this.playbackStartMs;
    if (elapsed < 0) {
      // Not time to start playback yet
      return null;
    }

    // Simple sequential playback: play the next packet in sequence
    const expectedSeq = this.playbackSeq;
    this.playbackSeq = expectedSeq + 1;

    // Try to get the expected packet
    let pkt = this.packets.get(expectedSeq);
    
    // If exact packet not found, try to find the next available packet (within reasonable window)
    if (!pkt && this.packets.size > 0) {
      const availableSeqs = Array.from(this.packets.keys()).sort((a, b) => a - b);
      // Look for a packet that's close to expected (within 15 packets = 300ms)
      for (const seq of availableSeqs) {
        if (seq >= expectedSeq && seq <= expectedSeq + 15) {
          pkt = this.packets.get(seq)!;
          this.playbackSeq = seq + 1;
          if (seq !== expectedSeq) {
            console.log(`⏭️ Skipped to packet seq ${seq} (expected ${expectedSeq}, gap: ${seq - expectedSeq})`);
          }
          break;
        }
      }
    }

    // Packet loss concealment: if no packet found, use last played packet (with fade)
    if (!pkt) {
      this.lossCount++;
      this.updateBuffer();
      
      // Use last played packet for concealment (will be faded in schedulePcm)
      if (this.lastPlayedPacket) {
        pkt = this.lastPlayedPacket;
        // Mark it as concealed so we can fade it
        (pkt as any).concealed = true;
        // Only log occasionally to reduce spam
        if (this.lossCount === 1 || this.lossCount % 50 === 0) {
          const availableSeqs = Array.from(this.packets.keys()).sort((a, b) => a - b);
          if (availableSeqs.length > 0) {
            console.warn(`[Conceal] missing packet seq ${expectedSeq} (using last packet), buffer has ${this.packets.size} packets`);
          } else {
            console.warn(`[Conceal] missing packet seq ${expectedSeq} (using last packet), buffer is empty`);
          }
        }
      } else {
        // No last packet to conceal with
        if (this.lossCount === 1 || this.lossCount % 50 === 0) {
          const availableSeqs = Array.from(this.packets.keys()).sort((a, b) => a - b);
          if (availableSeqs.length > 0) {
            console.warn(`[Missing] packet seq ${expectedSeq}, buffer has ${this.packets.size} packets, earliest: ${availableSeqs[0]}, latest: ${availableSeqs[availableSeqs.length - 1]}`);
          } else {
            console.warn(`[Missing] packet seq ${expectedSeq}, buffer is empty`);
          }
        }
        return null;
      }
    } else {
      // We have a real packet, remove it from buffer and update last played
      this.packets.delete(pkt.seq);
      this.lastPlayedPacket = pkt;
      (pkt as any).concealed = false;
    }

    this.updateBuffer();
    return pkt;
  }

  resetWindow() {
    this.lossCount = 0;
    this.receivedCount = 0;
    this.lateCount = 0;
  }
  
  // Reset all buffer state (for stop/start cycles)
  reset() {
    this.packets.clear();
    this.playbackSeq = null;
    this.startPtsMs = null;
    this.playbackStartMs = null;
    this.lastPlayedPacket = null;
    this.lossCount = 0;
    this.receivedCount = 0;
    this.lateCount = 0;
    this.lastSeq = null;
    this.bufferMs = 0;
  }
}

interface AbrState {
  currentTier: number;
  minTier: number;
  maxTierAllowed: number;
  stableMs: number;
  consecutiveLateOrMissing: number;
}
interface AbrInputs {
  lossPercent2s: number;
  bufferMs: number;
  lateRate: number;
  deltaMs: number;
}

function updateAbr(state: AbrState, inputs: AbrInputs, tierBuf: JitterBuffer, allTiers: Map<number, JitterBuffer>): AbrState {
  const next = { ...state };
  next.stableMs += inputs.deltaMs;

  // Check if current tier has packets in buffer
  const hasPackets = (tierBuf as any).packets.size > 0;
  const bufferInitialized = (tierBuf as any).playbackSeq !== null;
  const playbackStarted = (tierBuf as any).playbackStartMs !== null && 
                          performance.now() >= (tierBuf as any).playbackStartMs;

  // Check if target tier would have packets before switching
  const checkTierHasPackets = (tier: number): boolean => {
    const buf = allTiers.get(tier);
    if (!buf) return false;
    return (buf as any).packets.size > 0 || (buf as any).playbackSeq !== null;
  };

  // Don't downgrade if:
  // 1. Current tier has packets in buffer AND buffer is initialized
  // 2. OR playback hasn't started yet (still in initial delay)
  // 3. OR target tier doesn't have packets (would cause silence)
  // CRITICAL: Never downgrade to a tier that has no packets - this causes silence!
  const targetTier = next.currentTier - 1;
  const targetTierHasPackets = targetTier >= MIN_TIER && checkTierHasPackets(targetTier);
  
  // SIMPLIFIED: Only downgrade if we have sustained packet loss
  // Don't downgrade for temporary buffer issues - that's normal
  const hasRealProblem = inputs.lossPercent2s > 10 || 
                         (next.consecutiveLateOrMissing >= 10 && playbackStarted);
  
  const shouldDown =
    hasRealProblem &&
    // Don't downgrade if current tier has packets and is initialized
    !(hasPackets && bufferInitialized) &&
    // Don't downgrade during initial delay
    playbackStarted &&
    // CRITICAL: Don't downgrade if target tier doesn't have packets (would cause silence)
    targetTierHasPackets &&
    // Don't downgrade if current tier has packets (buffer is healthy)
    (tierBuf as any).packets.size > 0;

  if (shouldDown) {
    const oldTier = next.currentTier;
    const newTier = Math.max(next.currentTier - 1, next.minTier);
    
    // CRITICAL: Double-check that the new tier actually has packets before switching
    const newTierBuf = allTiers.get(newTier);
    const newTierHasPackets = newTierBuf && ((newTierBuf as any).packets.size > 0 || (newTierBuf as any).playbackSeq !== null);
    
    if (!newTierHasPackets) {
      // Target tier doesn't have packets, don't downgrade
      console.warn(`[ABR] Wanted to downgrade to tier ${newTier} but it has no packets, staying on tier ${oldTier}`);
      return next;
    }
    
    next.currentTier = newTier;
    if (oldTier !== next.currentTier) {
      console.log(`⬇️ ABR downgrading: ${oldTier} → ${next.currentTier} (loss: ${inputs.lossPercent2s.toFixed(1)}%, buffer: ${inputs.bufferMs}ms, missing: ${next.consecutiveLateOrMissing})`);
    }
    next.stableMs = 0;
    next.consecutiveLateOrMissing = 0;
    return next;
  }

  // Only upgrade if target tier has packets
  const canUp =
    next.stableMs >= 15_000 && 
    inputs.lossPercent2s < 1 && 
    inputs.bufferMs > 250 &&
    checkTierHasPackets(next.currentTier + 1);

  if (canUp) {
    const oldTier = next.currentTier;
    next.currentTier = Math.min(next.currentTier + 1, next.maxTierAllowed);
    if (oldTier !== next.currentTier) {
      console.log(`⬆️ ABR upgrading: ${oldTier} → ${next.currentTier}`);
    }
    next.stableMs = 0;
  }

  return next;
}

// DOM refs
const stationsGrid = document.getElementById("stations-grid")!;
const stationsSearchTopbar = document.getElementById("stations-search-topbar") as HTMLInputElement | null;
const favoritesFilter = document.getElementById("favorites-filter") as HTMLInputElement | null;
const favoritesFilterWrap = document.getElementById("favorites-filter-wrap");
const topbarSearchWrap = document.getElementById("topbar-search-wrap");
const footerPlayer = document.getElementById("footer-player")!;
const nowPlayingTitle = document.getElementById("now-playing-title")!;
const nowPlayingDesc = document.getElementById("now-playing-desc")!;
const playerCoverWrap = document.getElementById("player-cover-wrap")!;
const playerCover = document.getElementById("player-cover")! as HTMLImageElement;
const playerCoverInitial = document.getElementById("player-cover-initial")!;
const btnPlayPause = document.getElementById("btn-play-pause") as HTMLButtonElement;
const playPauseIcon = document.getElementById("play-pause-icon")!;
const playPauseText = document.getElementById("play-pause-text")!;
const playerLiveBadge = document.getElementById("player-live-badge")!;
const playerStatusText = document.getElementById("player-status-text")!;
const statTier = document.getElementById("stat-tier")!;
const statLoss = document.getElementById("stat-loss")!;
const statBuffer = document.getElementById("stat-buffer")!;
const statLate = document.getElementById("stat-late")!;
const statLatency = document.getElementById("stat-latency")!;
const statKbps = document.getElementById("stat-kbps")!;
const chatMessages = document.getElementById("chat-messages")!;
const chatSigninPrompt = document.getElementById("chat-signin-prompt")!;
const chatInputRow = document.getElementById("chat-input-row")!;
const chatInput = document.getElementById("chat-input")! as HTMLInputElement;
const chatSendBtn = document.getElementById("chat-send")!;
const externalStreamActions = document.getElementById("external-stream-actions")!;
const externalVisitWebsite = document.getElementById("external-visit-website")! as HTMLAnchorElement;
const playerStatGrid = document.getElementById("player-stat-grid")!;
const playerChatPanel = document.getElementById("player-chat-panel")!;
const nowPlayingProgram = document.getElementById("now-playing-program")!;
const nowPlayingProgramWrap = document.getElementById("now-playing-program-wrap")!;
const btnPrevStation = document.getElementById("btn-prev-station")!;
const btnNextStation = document.getElementById("btn-next-station")!;

function showPauseButton() {
  btnPlayPause.disabled = false;
  btnPlayPause.classList.remove("hidden");
  playPauseIcon.textContent = "\u23F8"; // ⏸ Pause
  playPauseText.textContent = "Pause";
}

function showPlayButton(label: "Start" | "Play" = "Play") {
  btnPlayPause.disabled = false;
  btnPlayPause.classList.remove("hidden");
  playPauseIcon.textContent = "\u25B6"; // ▶
  playPauseText.textContent = label;
}

let token: string | null = localStorage.getItem("laf_token");
let userEmail: string | null = localStorage.getItem("laf_user_email");

/** Emails allowed to access the admin panel and add stations. */
const ALLOWED_ADMIN_EMAILS = ["ale@forma.city"];

function isAllowedAdmin(): boolean {
  return !!(token && userEmail && ALLOWED_ADMIN_EMAILS.includes(userEmail.trim().toLowerCase()));
}

function updateTopBarAuth() {
  const signinLink = document.getElementById("client-signin-link")!;
  const userEmailEl = document.getElementById("client-user-email")!;
  const logoutBtn = document.getElementById("client-logout-btn")!;
  const signinLinkDrawer = document.getElementById("client-signin-link-drawer");
  const userEmailDrawer = document.getElementById("client-user-email-drawer");
  const logoutBtnDrawer = document.getElementById("client-logout-btn-drawer");
  const navAdmin = document.getElementById("nav-admin");
  const drawerAdmin = document.getElementById("drawer-admin");
  const showAdmin = isAllowedAdmin();
  if (token && userEmail) {
    signinLink.classList.add("hidden");
    userEmailEl.textContent = userEmail;
    userEmailEl.classList.remove("hidden");
    logoutBtn.classList.remove("hidden");
    if (signinLinkDrawer) signinLinkDrawer.classList.add("hidden");
    if (userEmailDrawer) { userEmailDrawer.textContent = userEmail; userEmailDrawer.classList.remove("hidden"); }
    if (logoutBtnDrawer) logoutBtnDrawer.classList.remove("hidden");
    if (navAdmin) navAdmin.classList.toggle("hidden", !showAdmin);
    if (drawerAdmin) drawerAdmin.classList.toggle("hidden", !showAdmin);
    chatSigninPrompt.classList.add("hidden");
    chatInputRow.classList.remove("hidden");
    if (favoritesFilterWrap) favoritesFilterWrap.classList.remove("hidden");
    loadFavorites().then(() => renderUnifiedStations());
  } else {
    signinLink.classList.remove("hidden");
    userEmailEl.classList.add("hidden");
    logoutBtn.classList.add("hidden");
    if (signinLinkDrawer) signinLinkDrawer.classList.remove("hidden");
    if (userEmailDrawer) { userEmailDrawer.classList.add("hidden"); }
    if (logoutBtnDrawer) logoutBtnDrawer.classList.add("hidden");
    if (navAdmin) navAdmin.classList.add("hidden");
    if (drawerAdmin) drawerAdmin.classList.add("hidden");
    chatSigninPrompt.classList.remove("hidden");
    chatInputRow.classList.add("hidden");
    if (favoritesFilterWrap) favoritesFilterWrap.classList.add("hidden");
    favoriteRefs = new Set();
  }
}

function appendChatMessage(email: string, text: string, ts?: number) {
  const div = document.createElement("div");
  div.className = "chat-message";
  const time = ts ? new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  div.innerHTML = `<span class="chat-author">${escapeHtml(email)}${time ? ` <small>${time}</small>` : ""}</span> ${escapeHtml(text)}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showConfirm(options: {
  message: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}): Promise<boolean> {
  const overlay = document.getElementById("confirm-overlay")!;
  const titleEl = document.getElementById("confirm-title")!;
  const messageEl = document.getElementById("confirm-message")!;
  const cancelBtn = document.getElementById("confirm-cancel-btn")!;
  const okBtn = document.getElementById("confirm-ok-btn")!;
  titleEl.textContent = options.title ?? "Confirm";
  messageEl.textContent = options.message;
  cancelBtn.textContent = options.cancelText ?? "Cancel";
  okBtn.textContent = options.confirmText ?? "OK";
  okBtn.classList.toggle("danger", !!options.danger);
  overlay.classList.add("visible");
  overlay.setAttribute("aria-hidden", "false");
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      overlay.classList.remove("visible");
      overlay.setAttribute("aria-hidden", "true");
      overlay.onclick = null;
      cancelBtn.onclick = null;
      okBtn.onclick = null;
      window.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(false);
    };
    overlay.onclick = (e) => {
      if (e.target === overlay) done(false);
    };
    window.addEventListener("keydown", onKey);
    cancelBtn.onclick = () => done(false);
    okBtn.onclick = () => done(true);
  });
}

let ws: WebSocket | null = null;
let audioCtx: AudioContext | null = null;
let opusDecoder: OpusDecoder | null = null;
let analyserNode: AnalyserNode | null = null;
let lafGain: GainNode | null = null;
let mediaSource: MediaElementAudioSourceNode | null = null;
const FREQ_BIN_COUNT = 256;

const tiers = new Map<number, JitterBuffer>();
// Create jitter buffers with larger initial delay and buffer for smooth streaming
// Initial delay: 1000ms (1 second) to build up buffer before playback
// Min buffer: 30 packets (~600ms) before starting playback
// Max buffer: 100 packets (~2 seconds) to prevent memory overflow
for (let t = MIN_TIER; t <= MAX_TIER_ALLOWED; t++) {
  tiers.set(t, new JitterBuffer(1000, 30, 100)); // 1000ms delay, 30 packets minimum, 100 packets max
}

let abrState: AbrState = {
  currentTier: START_TIER,
  minTier: MIN_TIER,
  maxTierAllowed: MAX_TIER_ALLOWED,
  stableMs: 0,
  consecutiveLateOrMissing: 0
};

let lastStatsTime = performance.now();
let lossCountWindow = 0;
let recvCountWindow = 0;
let lateCountWindow = 0;
let currentChannel: LiveChannel | null = null;
let currentExternalStation: ExternalStation | null = null;
/** Currently live LAF channels (from /api/channels/live). */
let liveChannelsList: LiveChannel[] = [];
/** User favorites: Set of "kind:ref" (e.g. "laf:uuid", "external:https://..."). */
let favoriteRefs = new Set<string>();
/** Cache stream status so we don't re-show "Checking…" on every re-render. */
const streamStatusCache: Record<string, { ok: boolean; status: string }> = {};
/** When true, show "Looking for live radios…" and do not show stations until all stream checks are done. */
let streamCheckInProgress = false;

/** Return URL to use for Audio() playback. Use API proxy when page is HTTPS and stream is HTTP (mixed content). */
function getExternalStreamPlaybackUrl(streamUrl: string): string {
  if (typeof window === "undefined") return streamUrl;
  const pageHttps = window.location?.protocol === "https:";
  const streamHttps = streamUrl.startsWith("https:");
  if (pageHttps && !streamHttps) {
    return `${API_URL}/api/stream-proxy?url=${encodeURIComponent(streamUrl)}`;
  }
  return streamUrl;
}
/** Stations whose logo failed to load; show initial letter from the start on re-render (no blink). */
const logoLoadFailed = new Set<string>();
let externalAudio: HTMLAudioElement | null = null;
/** When we started connecting to the current external stream (for grace period before showing "Stream error"). */
let externalStreamConnectStartTime = 0;
const EXTERNAL_STREAM_CONNECT_GRACE_MS = 6000;
let playheadTime = 0;
let loopRunning = false;
let isStopping = false; // Flag to prevent audio scheduling during stop
let fadeOutStartTime: number | null = null; // When fade out started (for smooth fade)
let fadeOutDuration = 5000; // 5 seconds fade out
const LOOKAHEAD_PACKETS = 10; // Schedule 10 packets (200ms) ahead for smooth playback - increased for better stability

async function getOrCreateAudioContext(): Promise<AudioContext | null> {
  if (audioCtx) {
    if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = FREQ_BIN_COUNT * 2;
  analyserNode.smoothingTimeConstant = 0.6;
  analyserNode.connect(audioCtx.destination);
  if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});
  return audioCtx;
}

async function loadChannels() {
  try {
    const url = `${API_URL}/api/channels/live`;
    const res = await fetch(url + `?t=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate", "Accept": "application/json" },
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error("[loadChannels] HTTP", res.status, errorText);
      stationsGrid.innerHTML = `<p style='opacity: 0.7; color: #ef4444;'>Error loading channels: HTTP ${res.status}</p>`;
      return;
    }
    const channels: LiveChannel[] = await res.json();
    liveChannelsList = channels;
    renderUnifiedStations();
  if (channels.length === 0) {
    renderExternalStations();
    if (currentChannel) {
      if (ws) { loopRunning = false; ws.close(); ws = null; }
      updatePlayerStatus("stopped", "Stream ended");
      showPlayButton("Start");
      playerLiveBadge.classList.add("hidden");
    }
    return;
  }
  renderExternalStations();
  if (currentChannel && !channels.find(c => c.id === currentChannel.id)) {
      if (ws) {
        loopRunning = false;
        ws.close();
        ws = null;
      }
      updatePlayerStatus("stopped", "Stream ended");
      showPlayButton("Start");
      playerLiveBadge.classList.add("hidden");
      currentChannel = null;
    }
  } catch (err: any) {
    console.error("[loadChannels] Exception caught:", err);
    const errMsg = err.message || "Failed to load channels";
    stationsGrid.innerHTML = `<p style='opacity: 0.7; color: var(--status-offline, #c00);'>Error: ${escapeHtml(errMsg)}</p>`;
    renderExternalStations();
  }
}

async function loadFavorites(): Promise<void> {
  if (!token) return;
  try {
    const res = await fetch(`${API_URL}/api/me/favorites`, { credentials: "include", headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return;
    const list = (await res.json()) as Array<{ kind: string; ref: string }>;
    favoriteRefs = new Set(list.map((r) => `${r.kind}:${r.ref}`));
  } catch {
    favoriteRefs = new Set();
  }
}

async function toggleFavorite(kind: "laf" | "external", ref: string): Promise<void> {
  if (!token) return;
  const key = `${kind}:${ref}`;
  const isFav = favoriteRefs.has(key);
  try {
    if (isFav) {
      await fetch(`${API_URL}/api/me/favorites?kind=${encodeURIComponent(kind)}&ref=${encodeURIComponent(ref)}`, {
        method: "DELETE",
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      });
      favoriteRefs.delete(key);
    } else {
      await fetch(`${API_URL}/api/me/favorites`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind, ref }),
      });
      favoriteRefs.add(key);
    }
    renderUnifiedStations();
  } catch (e) {
    console.error("Failed to toggle favorite:", e);
  }
}

function renderUnifiedStations(): void {
  stationsGrid.innerHTML = "";
  if (streamCheckInProgress) {
    const urls = getAllStreamUrls();
    const liveCount = urls.filter((u) => streamStatusCache[u]?.ok).length;
    const total = urls.length;
    stationsGrid.innerHTML = `<p class='stations-loading-message'><span class='stations-loading-text'>Looking for live radios…</span> <span class='stations-loading-count'>(${liveCount} of ${total} live so far)</span></p>`;
    return;
  }
  const q = (stationsSearchTopbar?.value ?? "").trim().toLowerCase();
  const onlyFavorites = favoritesFilter?.checked ?? false;

  type Item =
    | { type: "laf"; channel: LiveChannel }
    | { type: "external"; station: ExternalStation }
    | { type: "external_multi"; config: ExternalStationConfig; liveChannels: Array<{ name: string; streamUrl: string }> };
  const items: Item[] = [
    ...liveChannelsList.filter((c) => c.id && c.streamId).map((c) => ({ type: "laf" as const, channel: c })),
  ];

  for (const config of EXTERNAL_STATION_CONFIGS) {
    if (stationOverrides[config.streamUrl]?.hidden) continue;
    const configWithOverride = applyStationOverride(
      { name: config.name, description: config.description, websiteUrl: config.websiteUrl, logoUrl: config.logoUrl },
      config.streamUrl
    );
    if (config.channels && config.channels.length > 0) {
      const liveChannels = config.channels.filter((ch) => {
        if (stationOverrides[ch.streamUrl]?.hidden) return false;
        const c = streamStatusCache[ch.streamUrl];
        return c && c.ok;
      });
      if (liveChannels.length > 0) {
        const mergedConfig = { ...config, ...configWithOverride };
        items.push({ type: "external_multi", config: mergedConfig, liveChannels });
      }
    } else {
      const c = streamStatusCache[config.streamUrl];
      if (c && c.ok) {
        items.push({
          type: "external",
          station: {
            ...configWithOverride,
            streamUrl: config.streamUrl,
          },
        });
      }
    }
  }

  const userStationsLive = allExternalStations.filter((s) => {
    if (stationOverrides[s.streamUrl]?.hidden) return false;
    if (!s.id) return false;
    const cached = streamStatusCache[s.streamUrl];
    return cached && cached.ok;
  });
  for (const station of userStationsLive) {
    const stationWithOverride = applyStationOverride({ ...station }, station.streamUrl);
    items.push({ type: "external", station: { ...station, ...stationWithOverride } });
  }

  let filtered = items.filter((item) => {
    const name =
      item.type === "laf"
        ? item.channel.title
        : item.type === "external"
          ? item.station.name
          : item.config.name;
    const desc =
      item.type === "laf"
        ? item.channel.description || ""
        : item.type === "external"
          ? item.station.description || ""
          : item.config.description || "";
    if (q && !name.toLowerCase().includes(q) && !desc.toLowerCase().includes(q)) return false;
    if (onlyFavorites && token) {
      if (item.type === "laf") {
        if (!favoriteRefs.has(`laf:${item.channel.id}`)) return false;
      } else if (item.type === "external") {
        if (!favoriteRefs.has(`external:${item.station.streamUrl}`)) return false;
      } else {
        const anyFav = item.liveChannels.some((ch) => favoriteRefs.has(`external:${ch.streamUrl}`));
        if (!anyFav) return false;
      }
    }
    return true;
  });
  filtered.sort((a, b) => {
    const na =
      a.type === "laf" ? a.channel.title : a.type === "external" ? a.station.name : a.config.name;
    const nb =
      b.type === "laf" ? b.channel.title : b.type === "external" ? b.station.name : b.config.name;
    return na.localeCompare(nb, undefined, { sensitivity: "base" });
  });
  filtered.forEach((item) => {
    if (item.type === "laf") {
      const c = item.channel;
      const card = document.createElement("div");
      card.className = "channel-card";
      card.style.position = "relative";
      if (currentChannel?.id === c.id && ws && ws.readyState === WebSocket.OPEN) card.classList.add("now-playing");
      const coverHtml = c.coverUrl ? `<img src="${escapeAttr(c.coverUrl)}" alt="" class="channel-card-cover" />` : "";
      card.innerHTML = `
        <div class="card-title">${escapeHtml(c.title || "Untitled")}</div>
        <div class="card-body">
          ${coverHtml}
          <div class="channel-desc">${escapeHtml(c.description || "")}</div>
          <span class="live-badge">LIVE</span>
        </div>
        ${token ? `<button type="button" class="station-card-fav ${favoriteRefs.has("laf:" + c.id) ? "favorited" : ""}" data-kind="laf" data-ref="${escapeAttr(c.id)}" aria-label="Favorite">${favoriteRefs.has("laf:" + c.id) ? "♥" : "♡"}</button>` : ""}
      `;
      card.onclick = (e) => {
        if ((e.target as HTMLElement).closest(".station-card-fav")) return;
        selectChannel(c);
      };
      const favBtn = card.querySelector(".station-card-fav");
      if (favBtn) {
        favBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleFavorite("laf", c.id);
        });
      }
      stationsGrid.appendChild(card);
    } else if (item.type === "external") {
      const station = item.station;
      const card = document.createElement("div");
      card.className = "external-station-card";
      card.dataset.streamUrl = station.streamUrl;
      card.style.position = "relative";
      if (currentExternalStation?.streamUrl === station.streamUrl) card.classList.add("now-playing");
      const cached = streamStatusCache[station.streamUrl];
      const { text: statusText, statusClass } = getStatusLabel(cached, station.streamUrl);
      const hasLogo = !!station.logoUrl;
      const initial = (station.name.trim().charAt(0) || "?").toUpperCase();
      const logoFailed = hasLogo && logoLoadFailed.has(station.streamUrl);
      const logoHtml = hasLogo
        ? logoFailed
          ? `<div class="ext-station-logo-wrap"><span class="ext-station-initial">${escapeHtml(initial)}</span></div>`
          : `<div class="ext-station-logo-wrap"><img src="${escapeAttr(station.logoUrl)}" alt="" class="ext-station-logo" /><span class="ext-station-initial hidden">${escapeHtml(initial)}</span></div>`
        : `<div class="ext-station-name-only">${escapeHtml(station.name)}</div>`;
      card.innerHTML = `
        ${logoHtml}
        ${hasLogo ? `<div class="ext-name">${escapeHtml(station.name)}</div>` : ""}
        <div class="ext-desc">${escapeHtml(station.description)}</div>
        <a class="ext-link" href="${escapeAttr(station.websiteUrl)}" target="_blank" rel="noopener">Visit website</a>
        <div class="ext-stream-status ${statusClass}" aria-live="polite">${escapeHtml(statusText)}</div>
        ${token ? `<button type="button" class="station-card-fav ${favoriteRefs.has("external:" + station.streamUrl) ? "favorited" : ""}" data-kind="external" data-ref="${escapeAttr(station.streamUrl)}" aria-label="Favorite">${favoriteRefs.has("external:" + station.streamUrl) ? "♥" : "♡"}</button>` : ""}
      `;
      if (hasLogo && !logoFailed) {
        const img = card.querySelector<HTMLImageElement>(".ext-station-logo");
        const fallback = card.querySelector(".ext-station-initial");
        if (img && fallback) {
          img.onerror = () => {
            logoLoadFailed.add(station.streamUrl);
            img.style.display = "none";
            fallback.classList.remove("hidden");
            renderUnifiedStations();
          };
        }
      }
      if (cached && !cached.ok) card.classList.add("stream-offline");
      card.onclick = (e) => {
        if ((e.target as HTMLElement).closest(".station-card-fav") || (e.target as HTMLElement).closest("a.ext-link")) return;
        selectExternalStation(station);
      };
      const favBtn = card.querySelector(".station-card-fav");
      if (favBtn) {
        favBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleFavorite("external", station.streamUrl);
        });
      }
      stationsGrid.appendChild(card);
    } else if (item.type === "external_multi") {
      const config = item.config;
      const liveChannels = item.liveChannels;
      const hasLogo = !!config.logoUrl;
      const initial = (config.name.trim().charAt(0) || "?").toUpperCase();
      const logoFailed = hasLogo && logoLoadFailed.has(config.logoUrl);
      const logoHtml = hasLogo
        ? logoFailed
          ? `<div class="ext-station-logo-wrap"><span class="ext-station-initial">${escapeHtml(initial)}</span></div>`
          : `<div class="ext-station-logo-wrap"><img src="${escapeAttr(config.logoUrl)}" alt="" class="ext-station-logo" /><span class="ext-station-initial hidden">${escapeHtml(initial)}</span></div>`
        : `<div class="ext-station-name-only">${escapeHtml(config.name)}</div>`;
      const channelRows = liveChannels
        .map((ch) => {
          const cached = streamStatusCache[ch.streamUrl];
          const { text: statusText, statusClass } = getStatusLabel(cached, ch.streamUrl);
          const isPlaying = currentExternalStation?.streamUrl === ch.streamUrl;
          return `<button type="button" class="ext-channel-row ${isPlaying ? "now-playing" : ""}" data-stream-url="${escapeAttr(ch.streamUrl)}">
            <span class="ext-channel-name">${escapeHtml(ch.name)}</span>
            <span class="ext-stream-status ${statusClass}">${escapeHtml(statusText)}</span>
          </button>`;
        })
        .join("");
      const card = document.createElement("div");
      card.className = "external-station-card external-station-card-multi";
      card.style.position = "relative";
      card.innerHTML = `
        ${logoHtml}
        ${hasLogo ? `<div class="ext-name">${escapeHtml(config.name)}</div>` : ""}
        <div class="ext-desc">${escapeHtml(config.description)}</div>
        <a class="ext-link" href="${escapeAttr(config.websiteUrl)}" target="_blank" rel="noopener">Visit website</a>
        <div class="ext-channels-list">${channelRows}</div>
      `;
      if (hasLogo && !logoFailed) {
        const img = card.querySelector<HTMLImageElement>(".ext-station-logo");
        const fallback = card.querySelector(".ext-station-initial");
        if (img && fallback) {
          img.onerror = () => {
            logoLoadFailed.add(config.logoUrl);
            renderUnifiedStations();
          };
        }
      }
      card.onclick = (e) => {
        if ((e.target as HTMLElement).closest("a.ext-link")) return;
        const row = (e.target as HTMLElement).closest(".ext-channel-row");
        if (row) {
          e.preventDefault();
          const streamUrl = row.getAttribute("data-stream-url");
          if (streamUrl) {
            const ch = liveChannels.find((c) => c.streamUrl === streamUrl);
            if (ch) {
              selectExternalStation({
                name: `${config.name}: ${ch.name}`,
                description: config.description,
                websiteUrl: config.websiteUrl,
                streamUrl: ch.streamUrl,
                logoUrl: config.logoUrl,
              });
            }
          }
        }
      };
      stationsGrid.appendChild(card);
    }
  });
  const allUrls = getAllStreamUrls();
  const uncachedCount = allUrls.filter((u) => streamStatusCache[u] === undefined).length;
  if (filtered.length === 0) {
    if (uncachedCount > 0) {
      stationsGrid.innerHTML = "<p style='opacity: 0.7;'>Checking which stations are live…</p>";
    } else {
      stationsGrid.innerHTML = "<p style='opacity: 0.7;'>No stations currently live.</p>";
    }
  }
}

function getStatusLabel(
  cached: { ok: boolean; status: string } | undefined,
  streamUrl?: string
): { text: string; statusClass: string } {
  // Currently playing this stream → show LIVE
  if (streamUrl && currentExternalStation?.streamUrl === streamUrl) {
    return { text: "LIVE", statusClass: "status-live" };
  }
  if (!cached) return { text: "—", statusClass: "status-unknown" };
  if (cached.ok) return { text: "LIVE", statusClass: "status-live" };
  const label = cached.status === "timeout" ? "Timeout" : cached.status === "unavailable" ? "Offline" : "Error";
  const statusClass = cached.status === "timeout" ? "status-timeout" : cached.status === "unavailable" ? "status-offline" : "status-error";
  return { text: label, statusClass };
}

const STREAM_CHECK_TIMEOUT_MS = 3500;
const STREAM_CHECK_BATCH_SIZE = 6;
const STREAM_RECHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 min

function updateCardStatus(streamUrl: string, ok: boolean, status: string) {
  streamStatusCache[streamUrl] = { ok, status };
  document.querySelectorAll<HTMLElement>(`.external-station-card[data-stream-url="${CSS.escape(streamUrl)}"]`).forEach((card) => {
    const el = card.querySelector(".ext-stream-status");
    if (!el) return;
    const { text, statusClass } = getStatusLabel({ ok, status }, streamUrl);
    el.classList.remove("status-unknown", "status-live", "status-offline", "status-error", "status-timeout");
    el.textContent = text;
    el.classList.add(statusClass);
    if (ok) card.classList.remove("stream-offline");
    else card.classList.add("stream-offline");
  });
  document.querySelectorAll<HTMLElement>(`.ext-channel-row[data-stream-url="${CSS.escape(streamUrl)}"]`).forEach((row) => {
    const el = row.querySelector(".ext-stream-status");
    if (!el) return;
    const { text, statusClass } = getStatusLabel({ ok, status }, streamUrl);
    el.classList.remove("status-unknown", "status-live", "status-offline", "status-error", "status-timeout");
    el.textContent = text;
    el.classList.add(statusClass);
  });
}

/** Check a single stream (used on demand when user selects, or in full check). Skips if already cached unless force. */
function checkOneStream(streamUrl: string, force = false): Promise<void> {
  if (!force && streamStatusCache[streamUrl] !== undefined) return Promise.resolve();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STREAM_CHECK_TIMEOUT_MS);
  return fetch(`${API_URL}/api/stream-check?url=${encodeURIComponent(streamUrl)}`, { signal: controller.signal })
    .then((res) => res.json() as Promise<{ ok?: boolean; status?: string }>)
    .then((data) => {
      clearTimeout(timeoutId);
      updateCardStatus(streamUrl, !!data.ok, data.status || "error");
    })
    .catch(() => {
      clearTimeout(timeoutId);
      updateCardStatus(streamUrl, false, "error");
    });
}

/** Run stream checks for all URLs in batches; show "Looking for live radios" until all are done, then render once. */
function runFullStreamCheck() {
  const urls = getAllStreamUrls();
  const toCheck = urls.filter((u) => streamStatusCache[u] === undefined);
  if (toCheck.length === 0) return;
  streamCheckInProgress = true;
  renderUnifiedStations();
  let index = 0;
  function runNextBatch() {
    const batch = toCheck.slice(index, index + STREAM_CHECK_BATCH_SIZE);
    index += STREAM_CHECK_BATCH_SIZE;
    if (batch.length === 0) return;
    Promise.all(batch.map((u) => checkOneStream(u))).then(() => {
      renderUnifiedStations();
      if (index >= toCheck.length) {
        streamCheckInProgress = false;
        renderUnifiedStations();
      } else {
        setTimeout(runNextBatch, 800);
      }
    });
  }
  runNextBatch();
}

/** Clear stream status cache for all known URLs (used before periodic re-check). */
function clearStreamStatusCache() {
  getAllStreamUrls().forEach((url) => delete streamStatusCache[url]);
}

function renderExternalStations() {
  renderUnifiedStations();
  setTimeout(runFullStreamCheck, 100);
}

function selectExternalStation(station: ExternalStation) {
  if (currentExternalStation?.streamUrl === station.streamUrl) return;
  if (currentChannel || ws) {
    stopListening();
    currentChannel = null;
  }
  stopExternalStream();
  currentExternalStation = station;
  checkOneStream(station.streamUrl);
  nowPlayingTitle.textContent = station.name;
  nowPlayingDesc.textContent = station.description;
  externalVisitWebsite.href = station.websiteUrl;
  externalVisitWebsite.textContent = "Visit " + station.name;
  externalStreamActions.classList.remove("hidden");
  playerStatGrid.classList.add("hidden");
  playerChatPanel.classList.add("hidden");
  playerCoverWrap.classList.add("external-logo");
  const initial = (station.name.trim().charAt(0) || "?").toUpperCase();
  playerCoverInitial.textContent = initial;
  playerCoverInitial.classList.add("hidden");
  playerCover.style.display = "";
  if (station.logoUrl) {
    playerCover.src = station.logoUrl;
    playerCoverWrap.classList.remove("placeholder");
    playerCover.onerror = () => {
      logoLoadFailed.add(station.streamUrl);
      playerCover.style.display = "none";
      playerCover.removeAttribute("src");
      playerCoverInitial.textContent = initial;
      playerCoverInitial.classList.remove("hidden");
    };
  } else {
    playerCoverWrap.classList.add("placeholder");
    playerCover.removeAttribute("src");
    playerCoverInitial.classList.add("hidden");
  }
  if (externalAudio) {
    externalAudio.pause();
    externalAudio.src = "";
  }
  if (mediaSource) {
    try { mediaSource.disconnect(); } catch (_) {}
    mediaSource = null;
  }
  const playbackUrl = getExternalStreamPlaybackUrl(station.streamUrl);
  externalAudio = new Audio(playbackUrl);
  externalStreamConnectStartTime = Date.now();
  btnPrevStation.classList.remove("hidden");
  btnNextStation.classList.remove("hidden");
  nowPlayingProgramWrap.classList.add("hidden");
  nowPlayingProgram.textContent = "";
  Promise.all([
    fetchStationNowPlayingViaApi(station.websiteUrl),
    fetchStreamMetadataViaApi(station.streamUrl),
  ]).then(([scraped, icy]) => {
    if (currentExternalStation?.streamUrl !== station.streamUrl) return;
    const text = (scraped && scraped.trim()) || (icy && icy.trim()) || null;
    if (text) {
      nowPlayingProgram.textContent = text.length > 120 ? text.slice(0, 117) + "…" : text;
      nowPlayingProgramWrap.classList.remove("hidden");
    }
  }).catch(() => {});

  externalAudio.onplaying = () => updatePlayerStatus("playing", "Listening to stream");
  externalAudio.onerror = () => {
    const elapsed = Date.now() - externalStreamConnectStartTime;
    if (elapsed < EXTERNAL_STREAM_CONNECT_GRACE_MS) {
      updatePlayerStatus("playing", "Connecting…");
    } else {
      updatePlayerStatus("stopped", "Stream error");
    }
  };
  externalAudio.onended = () => {
    if (currentExternalStation?.streamUrl === station.streamUrl) {
      updatePlayerStatus("ready", "Stream ended");
    }
  };
  externalAudio.play().catch((err) => {
    console.error("[External stream] Play failed:", err);
    updatePlayerStatus("stopped", "Could not start stream");
  });
  updatePlayerStatus("playing", "Connecting…");
  showPauseButton();
  playerLiveBadge.classList.remove("hidden");
}

async function fetchStreamMetadataViaApi(streamUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/stream-metadata?url=${encodeURIComponent(streamUrl)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string | null; description?: string | null };
    const desc = data.description?.trim();
    const name = data.name?.trim();
    if (desc) return desc;
    if (name) return name;
    return null;
  } catch {
    return null;
  }
}

async function fetchStationNowPlayingViaApi(websiteUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/station-now-playing?url=${encodeURIComponent(websiteUrl)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { text?: string | null };
    return data.text?.trim() ?? null;
  } catch {
    return null;
  }
}

function pauseExternalStream() {
  if (externalAudio) {
    externalAudio.pause();
    // Keep externalAudio and currentExternalStation so we can resume
  }
  updatePlayerStatus("ready", "Paused");
  showPlayButton("Play");
  playerLiveBadge.classList.add("hidden");
}

function resumeExternalStream() {
  if (!currentExternalStation || !externalAudio) return;
  externalAudio.play().catch((err) => {
    console.error("[External stream] Resume failed:", err);
    updatePlayerStatus("stopped", "Could not resume stream");
  });
  updatePlayerStatus("playing", "Listening to stream");
  showPauseButton();
  playerLiveBadge.classList.remove("hidden");
}

function stopExternalStream() {
  if (externalAudio) {
    externalAudio.pause();
    externalAudio.src = "";
    externalAudio = null;
  }
  if (mediaSource) {
    try { mediaSource.disconnect(); } catch (_) {}
    mediaSource = null;
  }
  currentExternalStation = null;
  btnPrevStation.classList.add("hidden");
  btnNextStation.classList.add("hidden");
  externalStreamActions.classList.add("hidden");
  playerStatGrid.classList.remove("hidden");
  playerChatPanel.classList.remove("hidden");
  playerCoverWrap.classList.remove("external-logo");
  playerCoverInitial.classList.add("hidden");
  playerCover.style.display = "";
  nowPlayingTitle.textContent = "Not playing";
  nowPlayingDesc.textContent = "";
  nowPlayingProgramWrap.classList.add("hidden");
  nowPlayingProgram.textContent = "";
  updatePlayerStatus("ready", "Ready to listen");
  showPlayButton("Start");
  playerLiveBadge.classList.add("hidden");
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML.replace(/"/g, "&quot;");
}

function selectChannel(channel: LiveChannel) {
  const wasPlayingLaf = ws != null && ws.readyState === WebSocket.OPEN;
  if (currentExternalStation) stopExternalStream();
  currentChannel = channel;
  nowPlayingTitle.textContent = channel.title;
  nowPlayingDesc.textContent = channel.description || "";
  nowPlayingProgramWrap.classList.add("hidden");
  nowPlayingProgram.textContent = "";
  btnPrevStation.classList.add("hidden");
  btnNextStation.classList.add("hidden");
  playerCoverWrap.classList.remove("external-logo");
  playerCoverInitial.classList.add("hidden");
  playerCover.style.display = "";
  playerCover.onerror = null;
  if (channel.coverUrl) {
    playerCover.src = channel.coverUrl;
    playerCoverWrap.classList.remove("placeholder");
  } else {
    playerCover.removeAttribute("src");
    playerCoverWrap.classList.add("placeholder");
  }
  if (ws) {
    loopRunning = false;
    ws.close();
    ws = null;
  }
  if (wasPlayingLaf) {
    showPauseButton();
    playerLiveBadge.classList.remove("hidden");
    startListening().catch((e) => {
      console.error("Failed to switch channel:", e);
      showPlayButton("Play");
      playerLiveBadge.classList.add("hidden");
    });
  } else {
    showPlayButton("Start");
  }
}

async function startListening() {
  if (!currentChannel) return;
  btnPlayPause.disabled = true;

  console.log("[Listen] Starting - initializing fresh state...");
  
  // CRITICAL: Reset stopping flag and fade out state when starting a new stream
  isStopping = false;
  fadeOutStartTime = null;
  (window as any).lastShownCountdown = null; // Reset countdown tracker
  
  const ctx = await getOrCreateAudioContext();
  if (!ctx) return;
  audioCtx = ctx;
  playheadTime = audioCtx.currentTime;

  if (lafGain) lafGain.disconnect();
  lafGain = audioCtx.createGain();
  lafGain.gain.value = 1;
  lafGain.connect(analyserNode!);
  
  // Ensure ABR state is reset
  abrState = {
    currentTier: START_TIER,
    minTier: MIN_TIER,
    maxTierAllowed: MAX_TIER_ALLOWED,
    stableMs: 0,
    consecutiveLateOrMissing: 0
  };
  
  if (!opusDecoder) {
    opusDecoder = new OpusDecoder({
      channels: CHANNELS,
      sampleRate: SAMPLE_RATE,
    });
    await opusDecoder.ready;
  }

  chatMessages.innerHTML = "";

  const wsUrl = `${ensureRelayWsUrl(RELAY_BASE)}/?role=listener&streamId=${currentChannel.streamId}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  console.log("Connecting to relay:", wsUrl);
  console.log("Current ABR tier:", abrState.currentTier);
  console.log("Available tiers:", Array.from(tiers.keys()));
  
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = async () => {
    console.log("[WS] Connected to relay");
    console.log("Connected to stream");
    console.log("AudioContext state:", audioCtx?.state);
    if (audioCtx && audioCtx.state === "suspended") {
      await audioCtx.resume();
      console.log("AudioContext resumed after connection");
    }
    
    // Test audio output with a brief tone
    if (audioCtx) {
      const testBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.1, audioCtx.sampleRate);
      const testData = testBuffer.getChannelData(0);
      for (let i = 0; i < testData.length; i++) {
        testData[i] = Math.sin(2 * Math.PI * 440 * i / audioCtx.sampleRate) * 0.1; // 440Hz tone
      }
      const testSrc = audioCtx.createBufferSource();
      testSrc.buffer = testBuffer;
      testSrc.connect(audioCtx.destination);
      testSrc.start();
      console.log("Test tone played - if you hear a beep, audio is working");
    }
    
    loopRunning = true; // Start the loop
    loop(); // Start processing
    
    // Update UI
    updatePlayerStatus("playing", "Listening live");
    showPauseButton();
    playerLiveBadge.classList.remove("hidden");
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  ws.onclose = (event) => {
    console.log("[WS] Closed");
    console.log(`   Code: ${event.code}`);
    console.log(`   Reason: ${event.reason || "No reason"}`);
    console.log(`   Was clean: ${event.wasClean}`);
    console.log(`   Total messages received: ${messageCount}, last seq: ${lastLoggedSeq}`);
    
    if ((window as any).__streamEndCountdownInterval) {
      clearInterval((window as any).__streamEndCountdownInterval);
      (window as any).__streamEndCountdownInterval = null;
    }
    if ((ws as any).messageMonitor) {
      clearInterval((ws as any).messageMonitor);
    }
    
    stopListening();

    const reason = event.reason || "";
    updatePlayerStatus("stopped", reason.includes("Stream ended") ? "Stream ended" : "Disconnected");
    showPlayButton("Play");
    playPauseText.textContent = "Reconnect";
    playerLiveBadge.classList.add("hidden");
  };

  let lastMessageTime = performance.now();
  let messageCount = 0;
  let lastLoggedSeq = 0;
  
  // Monitor message reception to detect when they stop
  const messageMonitor = setInterval(() => {
    const timeSinceLastMessage = performance.now() - lastMessageTime;
    if (timeSinceLastMessage > 2000 && ws && ws.readyState === WebSocket.OPEN) {
      console.warn(`[WS] No messages received for ${timeSinceLastMessage.toFixed(0)}ms, WebSocket state: ${ws.readyState}`);
      console.warn(`   Last message count: ${messageCount}, last seq: ${lastLoggedSeq}`);
    }
  }, 2000);
  
  ws.onmessage = async (ev) => {
    lastMessageTime = performance.now();
    messageCount++;
    
    // Handle text messages (chat and control like "stream ending")
    if (typeof ev.data === "string") {
      try {
        const message = JSON.parse(ev.data);
        if (message.type === "chat" && message.email != null && message.text != null) {
          appendChatMessage(message.email, message.text, message.timestamp);
          return;
        }
        if (message.type === "stream_ending") {
          const countdown = message.countdown || 5;
          console.log(`[Stream] Ending notification - ${countdown} seconds until end`);
          console.log(`[Fade] Starting graceful fade out over ${countdown} seconds...`);
          
          // Start fade out
          fadeOutStartTime = performance.now();
          fadeOutDuration = countdown * 1000; // Convert to milliseconds
          (window as any).lastShownCountdown = countdown + 1; // Initialize countdown tracker
          
          // Update UI and tick countdown every second
          updatePlayerStatus("playing", `Stream ending in ${countdown}...`);
          let remaining = countdown;
          const countdownTick = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
              clearInterval(countdownTick);
              updatePlayerStatus("playing", "Stream ending…");
            } else {
              updatePlayerStatus("playing", `Stream ending in ${remaining}...`);
            }
          }, 1000);
          (window as any).__streamEndCountdownInterval = countdownTick;
        }
      } catch (err) {
        console.warn("Failed to parse control message:", err);
      }
      return;
    }
    
    // Handle binary messages (audio packets)
    if (!(ev.data instanceof ArrayBuffer)) {
      console.warn("Received non-ArrayBuffer message");
      return;
    }
    
    const pkt = decodeLAF(ev.data);
    if (!pkt) {
      console.warn("Failed to decode LAF packet, data size:", ev.data.byteLength);
      return;
    }
    
    lastLoggedSeq = pkt.seq;
    
    // Log first packet always
    if (pkt.seq === 1) {
      console.log("[First packet]", { tier: pkt.tier, seq: pkt.seq, streamId: pkt.streamId });
    }
    
    const buf = tiers.get(pkt.tier);
    if (!buf) {
      console.warn("[Unknown tier]:", pkt.tier, "available tiers:", Array.from(tiers.keys()));
      return;
    }
    
    const beforePush = buf.receivedCount;
    const playbackSeqBefore = (buf as any).playbackSeq;
    buf.push(pkt);
    const playbackSeqAfter = (buf as any).playbackSeq;
    
    // Log initialization
    if (playbackSeqBefore === null && playbackSeqAfter !== null) {
      console.log("[Jitter] Buffer initialized playbackSeq:", playbackSeqAfter, "playback starts in 1000ms");
    }
    
    // Log first few packets and periodically
    if (pkt.seq <= 5 || pkt.seq % 50 === 0 || beforePush === 0) {
      console.log("[Buffer] Pushed packet to tier", pkt.tier, ":", { 
        seq: pkt.seq, 
        payloadSize: pkt.opusPayload.length, 
        receivedCount: buf.receivedCount,
        bufferSize: (buf as any).packets.size,
        totalMessages: messageCount
      });
    }
  };
  
  // Store messageMonitor for cleanup
  (ws as any).messageMonitor = messageMonitor;

  // Loop will be started when WebSocket opens
}

function schedulePcm(ctx: AudioContext, pcm: Float32Array, isConcealed = false) {
  // CRITICAL: Don't schedule audio if we're stopping or stopped
  if (isStopping || !loopRunning) {
    return;
  }
  
  if (ctx.state === "suspended") {
    console.warn("AudioContext is suspended, cannot play audio");
    return;
  }
  
  if (pcm.length === 0) {
    console.warn("Empty PCM data");
    return;
  }
  
  const sampleCount = pcm.length;
  try {
    const buffer = ctx.createBuffer(CHANNELS, sampleCount, SAMPLE_RATE);
    const channelData = buffer.getChannelData(0);
    
    // Calculate fade out factor if fade out is active
    let fadeOutFactor = 1.0;
    if (fadeOutStartTime !== null) {
      const elapsed = performance.now() - fadeOutStartTime;
      
      // Add small ramp-in period (100ms) to prevent glitch when fade starts
      const RAMP_IN_MS = 100;
      const effectiveElapsed = Math.max(0, elapsed - RAMP_IN_MS);
      const effectiveDuration = fadeOutDuration - RAMP_IN_MS;
      
      if (elapsed >= fadeOutDuration) {
        // Fade out complete - stop scheduling audio and clean up
        console.log("[Fade] Complete - stopping audio and cleaning up");
        fadeOutStartTime = null;
        isStopping = true;
        
        // Don't stop loopRunning here - let the loop handle it naturally
        // This prevents the freeze issue
        
        // Clean up gracefully after fade-out completes
        // Use requestAnimationFrame to ensure UI updates happen
        requestAnimationFrame(() => {
          setTimeout(() => {
            stopListening();
            updatePlayerStatus("stopped", "Stream ended");
          }, 200); // Small delay to ensure last audio packet is scheduled
        });
        
        return;
      }
      
      // Smooth fade out with ramp-in: 1.0 at start, gradually fade to 0.0 at end
      // Use exponential curve for smoother fade (ease-out)
      if (effectiveElapsed <= 0) {
        fadeOutFactor = 1.0; // Full volume during ramp-in
      } else {
        const progress = Math.min(1.0, effectiveElapsed / effectiveDuration);
        // Exponential ease-out for smoother fade: 1 - (1 - progress)^2
        const easedProgress = 1 - Math.pow(1 - progress, 2);
        fadeOutFactor = 1.0 - easedProgress;
      }
      
      // Update UI countdown every second during fade-out
      const remainingSeconds = Math.ceil((fadeOutDuration - elapsed) / 1000);
      const lastShownCountdown = (window as any).lastShownCountdown || 999;
      if (remainingSeconds !== lastShownCountdown && remainingSeconds >= 0) {
        (window as any).lastShownCountdown = remainingSeconds;
        // Use requestAnimationFrame for smooth UI updates
        requestAnimationFrame(() => {
          if (remainingSeconds > 0) {
            updatePlayerStatus("playing", `Stream ending in ${remainingSeconds}...`);
          } else {
            updatePlayerStatus("playing", "Stream ending...");
          }
        });
      }
    }
    
    // If this is a concealed packet (packet loss), fade it out to reduce artifacts
    if (isConcealed) {
      const fadeLength = Math.min(sampleCount / 4, 240); // Fade last 25% or 5ms, whichever is smaller
      const fadeStart = sampleCount - fadeLength;
      for (let i = 0; i < sampleCount; i++) {
        let sample = pcm[i];
        if (i >= fadeStart) {
          const concealFadeFactor = 1 - ((i - fadeStart) / fadeLength);
          sample *= concealFadeFactor;
        }
        // Apply stream ending fade out
        sample *= fadeOutFactor;
        channelData[i] = sample;
      }
    } else {
      // Apply stream ending fade out to all samples
      for (let i = 0; i < sampleCount; i++) {
        channelData[i] = pcm[i] * fadeOutFactor;
      }
    }
    
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    
    // CRITICAL: Use playheadTime for continuous scheduling, but ensure we're not too far ahead
    const now = ctx.currentTime;
    // If playheadTime is too far in the past, reset it to now + small buffer
    if (playheadTime < now - 0.1) {
      playheadTime = now + 0.05; // Reset if we're more than 100ms behind
    }
    
    // Schedule at playheadTime to maintain continuity
    const targetTime = playheadTime;
    const dest = lafGain ?? ctx.destination;
    src.connect(dest);
    
    src.start(targetTime);
    // Update playheadTime for next packet (continuous scheduling)
    playheadTime = targetTime + buffer.duration;
  } catch (err) {
    console.error("Failed to schedule PCM:", err, "sampleCount:", sampleCount);
  }
}

function scheduleSilence(ctx: AudioContext) {
  // CRITICAL: Don't schedule silence if we're stopping or stopped
  if (isStopping || !loopRunning) {
    return;
  }
  
  if (ctx.state === "suspended") {
    return;
  }
  
  const buffer = ctx.createBuffer(CHANNELS, SAMPLES_PER_FRAME, SAMPLE_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const now = ctx.currentTime;
  // Use same timing logic as schedulePcm to maintain continuity
  const startTime = Math.max(playheadTime, now + 0.02);
  const dest = lafGain ?? ctx.destination;
  src.connect(dest);
  
  try {
    src.start(startTime);
    playheadTime = startTime + buffer.duration;
  } catch (err) {
    console.error("Failed to start silence:", err);
  }
}

let lastLoopTime = performance.now();
let loopIterations = 0;

async function loop() {
  loopIterations++;
  const now = performance.now();
  const timeSinceLastLoop = now - lastLoopTime;
  lastLoopTime = now;
  
  // Warn if loop is running slowly
  if (timeSinceLastLoop > 100 && loopIterations % 100 === 0) {
    console.warn(`[Loop] Running slowly: ${timeSinceLastLoop.toFixed(0)}ms since last iteration`);
  }
  
  // CRITICAL: Check both loopRunning and isStopping
  if (!loopRunning || isStopping) {
    if (isStopping) {
      console.log("Loop stopped due to fade-out completion");
    } else {
      console.log("Loop stopped");
    }
    return;
  }
  
  if (!audioCtx || !opusDecoder) {
    if (loopRunning) setTimeout(loop, 20);
    return;
  }

  const deltaMs = now - lastStatsTime;
  lastStatsTime = now;

  // Check if current tier has packets, if not try to find a tier that does
  let tierBuf = tiers.get(abrState.currentTier)!;
  let tierToUse = abrState.currentTier;
  
  // CRITICAL: If current tier has no packets available for playback, find ANY tier with packets
  // This prevents silence when ABR switches to a tier that doesn't have packets yet
  const currentTierHasPackets = (tierBuf as any).packets.size > 0 || 
                                 (tierBuf as any).playbackSeq !== null;
  
  if (!currentTierHasPackets) {
    // Try to find ANY tier with packets (check higher tiers first, then lower)
    let foundTier = false;
    
    // First check higher tiers (better quality)
    for (let t = abrState.currentTier + 1; t <= MAX_TIER_ALLOWED; t++) {
      const buf = tiers.get(t);
      if (buf && ((buf as any).packets.size > 0 || (buf as any).playbackSeq !== null)) {
        tierBuf = buf;
        tierToUse = t;
        foundTier = true;
        console.log(`⬆️ Tier ${abrState.currentTier} has no packets, using tier ${t} instead (higher quality)`);
        // Update ABR state to match the tier we're actually using
        abrState.currentTier = t;
        break;
      }
    }
    
    // If no higher tier, check lower tiers
    if (!foundTier) {
      for (let t = abrState.currentTier - 1; t >= MIN_TIER; t--) {
        const buf = tiers.get(t);
        if (buf && ((buf as any).packets.size > 0 || (buf as any).playbackSeq !== null)) {
          tierBuf = buf;
          tierToUse = t;
          foundTier = true;
          console.log(`⬇️ Tier ${abrState.currentTier} has no packets, using tier ${t} instead (lower quality)`);
          // Update ABR state to match the tier we're actually using
          abrState.currentTier = t;
          break;
        }
      }
    }
    
    // If still no tier found, log warning and keep using current tier (will play silence)
    if (!foundTier) {
      console.warn(`[ABR] No tier has packets available! Current tier: ${abrState.currentTier}`);
      for (const [t, buf] of tiers.entries()) {
        console.warn(`  Tier ${t}: packets=${(buf as any).packets.size}, playbackSeq=${(buf as any).playbackSeq}`);
      }
    }
  }
  
  // Buffer underrun protection: if buffer is getting too low during playback, slow down slightly
  const playbackStarted = (tierBuf as any).playbackStartMs !== null && 
                          performance.now() >= (tierBuf as any).playbackStartMs;
  const bufferPackets = (tierBuf as any).packets.size;
  if (playbackStarted && bufferPackets < 5) {
    // Buffer is getting low, this might cause chopping
    // The packet loss concealment will help, but we should log this
    if (bufferPackets === 0 && Math.floor(now / 1000) !== Math.floor((now - deltaMs) / 1000)) {
      console.warn(`[Buffer] Underrun: only ${bufferPackets} packets in buffer`);
    }
  }
  
  // Log buffer state occasionally (before resetWindow is called)
  if (Math.floor(now / 1000) !== Math.floor((now - deltaMs) / 1000)) {
    const stats = tierBuf;
    const playbackSeq = (tierBuf as any).playbackSeq;
    const playbackStartMs = (tierBuf as any).playbackStartMs;
    const packetCount = (tierBuf as any).packets.size;
    console.log(`[Tier ${tierToUse}] Buffer state: ${stats.bufferMs}ms, received: ${stats.receivedCount}, loss: ${stats.lossCount}, lastSeq: ${stats.lastSeq}, playbackSeq: ${playbackSeq}, packets in buffer: ${packetCount}`);
    
    // Also check other tiers
    for (const [tier, buf] of tiers.entries()) {
      if (tier !== tierToUse) {
        const otherPacketCount = (buf as any).packets.size;
        if (otherPacketCount > 0) {
          console.log(`[Tier ${tier}] Has ${otherPacketCount} packets in buffer`);
        }
      }
    }
  }
  
  // CRITICAL: Update ABR state to match the tier we're actually using
  // This prevents ABR from making decisions based on the wrong tier's buffer
  if (tierToUse !== abrState.currentTier) {
    console.log(`[ABR] state updated: ${abrState.currentTier} → ${tierToUse} (using tier with packets)`);
    abrState.currentTier = tierToUse;
  }
  
  // CRITICAL: Schedule multiple packets ahead (lookahead scheduling) for smooth playback
  // This prevents glitches by ensuring we always have audio scheduled ahead
  const nowAudioTime = audioCtx.currentTime;
  const timeUntilPlayhead = playheadTime - nowAudioTime;
  
  // Calculate how many packets we have scheduled ahead
  // Each packet is 20ms, so we need to check how many are scheduled
  const packetsAhead = Math.floor(timeUntilPlayhead / 0.02);
  
  // Schedule packets until we have enough lookahead (5 packets = 100ms)
  while (packetsAhead < LOOKAHEAD_PACKETS || timeUntilPlayhead < 0.1) {
    const pkt = tierBuf.popForPlayback(now);

    if (!pkt) {
      abrState.consecutiveLateOrMissing++;
      lossCountWindow++;
      
      // Check if other tiers have packets we could use
      let alternativeTier: number | null = null;
      for (const [t, buf] of tiers.entries()) {
        if (t !== tierToUse && ((buf as any).packets.size > 0 || (buf as any).playbackSeq !== null)) {
          alternativeTier = t;
          break;
        }
      }
      
      // Log missing packets more frequently to detect issues
      if (lossCountWindow === 1 || lossCountWindow % 5 === 0) {
        const bufferPackets = (tierBuf as any).packets.size;
        const lastSeq = tierBuf.lastSeq;
        const playbackSeq = (tierBuf as any).playbackSeq;
        if (alternativeTier) {
          const altBuf = tiers.get(alternativeTier)!;
          console.warn(`[ABR] Missing packet on tier ${tierToUse}: buffer=${bufferPackets}, playbackSeq=${playbackSeq}, but tier ${alternativeTier} has ${(altBuf as any).packets.size} packets - should switch!`);
        } else {
          console.warn(`[ABR] Missing packet on tier ${tierToUse}: buffer=${bufferPackets}, lastSeq=${lastSeq}, playbackSeq=${playbackSeq}, no alternative tiers available`);
        }
      }
      scheduleSilence(audioCtx);
      break; // Can't schedule more if no packets available
    } else {
    const isConcealed = (pkt as any).concealed === true;
    // Log first few packets to verify they're being processed
    if (pkt.seq <= 5 || (pkt.seq > 0 && pkt.seq % 100 === 0)) {
      console.log("[Process] packet:", { seq: pkt.seq, tier: pkt.tier, payloadSize: pkt.opusPayload.length, concealed: isConcealed });
    }
    abrState.consecutiveLateOrMissing = 0;
    try {
      // Try to decode as Opus first
      const decoded = await opusDecoder.decode(pkt.opusPayload);
      // opus-decoder returns Float32Array[] (one per channel)
      schedulePcm(audioCtx, decoded[0], isConcealed);
    } catch (err) {
      // If Opus decode fails, try to handle as raw PCM (Int16)
      // Only log first failure to reduce spam
      if (pkt.seq === 1 || pkt.seq % 100 === 0) {
        console.log("Opus decode failed, trying raw PCM (payload size:", pkt.opusPayload.length, ")");
      }
      try {
        // The broadcaster may send Int16 PCM (2 bytes per sample) or Int8 PCM (1 byte per sample)
        const byteLength = pkt.opusPayload.length;
        
        // Check if it's 8-bit PCM (1 byte per sample) or 16-bit PCM (2 bytes per sample)
        // 8-bit: 960 bytes for 20ms at 48kHz, 16-bit: 1920 bytes
        const is8Bit = byteLength === SAMPLES_PER_FRAME || (byteLength < SAMPLES_PER_FRAME * 1.5);
        
        let pcmFloat: Float32Array;
        
        if (is8Bit) {
          // 8-bit PCM: convert from Uint8 (0-255) to Float32 (-1.0 to 1.0)
          const sampleCount = byteLength;
          pcmFloat = new Float32Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            // Convert: 0 -> -1.0, 128 -> 0.0, 255 -> 1.0
            pcmFloat[i] = (pkt.opusPayload[i] - 128) / 127.5;
          }
        } else {
          // 16-bit PCM: convert from Int16Array
          if (byteLength % 2 !== 0) {
            console.warn("Odd byte length for 16-bit PCM:", byteLength);
            scheduleSilence(audioCtx);
            return;
          }
          
          const sampleCount = byteLength / 2;
          const pcm16 = new Int16Array(pkt.opusPayload.buffer, pkt.opusPayload.byteOffset, sampleCount);
          
          // Convert Int16 to Float32 (-1.0 to 1.0)
          pcmFloat = new Float32Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            const normalized = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
            pcmFloat[i] = Math.max(-1, Math.min(1, normalized));
          }
        }
        
        let maxSample = 0;
        for (let i = 0; i < pcmFloat.length; i++) {
          maxSample = Math.max(maxSample, Math.abs(pcmFloat[i]));
        }
        
        // Only log occasionally
        if (pkt.seq <= 10 || pkt.seq % 100 === 0) {
          console.log("Decoded raw PCM:", pcmFloat.length, "samples,", is8Bit ? "8-bit" : "16-bit", "max amplitude:", maxSample.toFixed(3));
        }
        
        // Check if we have actual audio data (not silence)
        if (maxSample < 0.001 && pkt.seq % 50 === 0) {
          console.warn("[Audio] Very quiet audio detected (max:", maxSample.toFixed(4), "), might be silence or mic issue");
        }
        
        schedulePcm(audioCtx, pcmFloat, isConcealed);
      } catch (pcmErr) {
        console.error("Failed to decode raw PCM:", pcmErr);
        scheduleSilence(audioCtx);
      }
    }
    
    // Recalculate lookahead after scheduling this packet
    const newTimeUntilPlayhead = playheadTime - audioCtx.currentTime;
    const newPacketsAhead = Math.floor(newTimeUntilPlayhead / 0.02);
    
    // If we have enough lookahead, break out of scheduling loop
    if (newPacketsAhead >= LOOKAHEAD_PACKETS && newTimeUntilPlayhead >= 0.1) {
      break;
    }
    // Otherwise continue scheduling more packets
    }
  }

  const stats = tierBuf;
  // Only accumulate stats if we've actually received packets
  if (stats.receivedCount > 0 || stats.lossCount > 0) {
    recvCountWindow += stats.receivedCount;
    lossCountWindow += stats.lossCount;
    lateCountWindow += stats.lateCount;
  }
  stats.resetWindow();

  const total = recvCountWindow + lossCountWindow;
  const lossPercent = total === 0 ? 0 : (lossCountWindow / total) * 100;
  const lateRate = total === 0 ? 0 : lateCountWindow / total;

  // CRITICAL: Sync ABR state with the tier we're actually using
  // This prevents ABR from making decisions based on wrong tier's buffer
  if (tierToUse !== abrState.currentTier) {
    console.log(`[ABR] Syncing state: ${abrState.currentTier} → ${tierToUse} (using tier with packets)`);
    abrState.currentTier = tierToUse;
  }
  
  const oldTier = abrState.currentTier;
  abrState = updateAbr(abrState, {
    lossPercent2s: lossPercent,
    bufferMs: stats.bufferMs, // This is from tierToUse's buffer (the tier we're actually playing)
    lateRate,
    deltaMs
  }, tierBuf, tiers);
  
  // Log tier changes
  if (abrState.currentTier !== oldTier) {
    console.log(`[ABR] tier changed: ${oldTier} → ${abrState.currentTier}`);
  }
  
  // After ABR update, if ABR switched to a tier without packets, revert to tier with packets
  if (abrState.currentTier !== tierToUse) {
    const newTierBuf = tiers.get(abrState.currentTier);
    const newTierHasPackets = newTierBuf && ((newTierBuf as any).packets.size > 0 || (newTierBuf as any).playbackSeq !== null);
    if (!newTierHasPackets) {
      console.warn(`[ABR] Switched to tier ${abrState.currentTier} but it has no packets, reverting to tier ${tierToUse}`);
      abrState.currentTier = tierToUse;
    }
  }

  if (Math.floor(now / 1000) !== Math.floor((now - deltaMs) / 1000)) {
    const estLatencyMs = stats.bufferMs;
    statTier.textContent = String(abrState.currentTier);
    statLoss.textContent = `${lossPercent.toFixed(1)}%`;
    statBuffer.textContent = `${stats.bufferMs.toFixed(0)}ms`;
    statLate.textContent = lateRate.toFixed(2);
    statLatency.textContent = `${estLatencyMs.toFixed(0)}ms`;
    statKbps.textContent = `${(SAMPLE_RATE / SAMPLES_PER_FRAME) * 1 * 8 / 1000 | 0}kbps`;

    lossCountWindow = 0;
    recvCountWindow = 0;
    lateCountWindow = 0;
  }

  // Schedule next iteration (approximately 20ms for 20ms audio frames)
  // Use requestAnimationFrame for more precise timing, but throttle to ~20ms
  // CRITICAL: Check both loopRunning and isStopping to prevent loop after fade-out
  if (loopRunning && !isStopping) {
    // Use a more precise timing mechanism
    const nextFrameTime = now + 18; // Slightly less than 20ms to account for processing time
    const delay = Math.max(0, nextFrameTime - performance.now());
    setTimeout(loop, Math.min(delay, 20));
  } else if (isStopping) {
    // Fade-out complete, stop the loop gracefully
    console.log("[Loop] Stopping due to fade-out completion");
    loopRunning = false;
  }
}

function updatePlayerStatus(status: "ready" | "playing" | "stopped", message: string) {
  footerPlayer.classList.toggle("is-playing", status === "playing");
  playerStatusText.textContent = message;
}

function stopListening() {
  console.log("[Stop] Stopping listening and cleaning up...");
  
  // CRITICAL: Set stopping flag FIRST to prevent any new audio scheduling
  isStopping = true;
  
  // Reset fade out state
  fadeOutStartTime = null;
  (window as any).lastShownCountdown = null; // Reset countdown tracker
  
  // Stop the loop to prevent any new audio processing
  loopRunning = false;
  
  // CRITICAL: Clear all jitter buffers IMMEDIATELY to prevent processing old packets
  // This must happen before suspending AudioContext to prevent glitchy sounds
  for (const [tier, buf] of tiers.entries()) {
    buf.reset(); // Use the reset method to clean up all state
  }
  console.log("[Stop] Jitter buffers cleared");
  
  // Close WebSocket
  if (ws) {
    // Clean up message monitor
    if ((ws as any).messageMonitor) {
      clearInterval((ws as any).messageMonitor);
    }
    // Close gracefully
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, "Client stopping");
    }
    ws = null;
  }
  
  // CRITICAL: Stop audio gracefully to prevent glitching
  // Suspend AudioContext immediately - this stops all scheduled audio
  // Buffers are already cleared, so no new audio will be processed
  if (audioCtx && audioCtx.state === "running") {
    try {
      audioCtx.suspend();
      console.log("[Stop] AudioContext suspended");
    } catch (err) {
      console.warn("[Error] Suspending AudioContext:", err);
    }
  }
  
  // Reset playheadTime - CRITICAL: reset audio scheduling
  if (audioCtx) {
    playheadTime = audioCtx.currentTime;
  } else {
    playheadTime = 0;
  }
  
  // Reset ABR state to initial values
  abrState = {
    currentTier: START_TIER,
    minTier: MIN_TIER,
    maxTierAllowed: MAX_TIER_ALLOWED,
    stableMs: 0,
    consecutiveLateOrMissing: 0
  };
  
  // Reset window counters
  lossCountWindow = 0;
  recvCountWindow = 0;
  lateCountWindow = 0;
  lastStatsTime = performance.now();
  lastLoopTime = performance.now();
  
  if (lafGain) {
    try { lafGain.disconnect(); } catch (_) {}
    lafGain = null;
  }

  // Reset stopping flag after a brief delay to ensure all audio has stopped
  setTimeout(() => {
    isStopping = false;
  }, 100);
  
  console.log("[Cleanup] Complete - state reset, audio stopped");
  updatePlayerStatus("stopped", "Stream ended");
  showPlayButton("Play");
  playerLiveBadge.classList.add("hidden");
}

btnPlayPause.onclick = () => {
  // External station: toggle pause/resume
  if (currentExternalStation) {
    if (externalAudio && !externalAudio.paused) {
      pauseExternalStream();
    } else {
      resumeExternalStream();
    }
    return;
  }
  // LAF channel: start or pause
  if (!currentChannel) return;
  const isPlaying = ws != null && ws.readyState === WebSocket.OPEN;
  if (isPlaying) {
    stopListening();
    return;
  }
  playPauseText.textContent = "Connecting...";
  btnPlayPause.disabled = true;
  updatePlayerStatus("ready", "Connecting...");
  startListening().catch((e) => {
    console.error("Failed to start listening:", e);
    alert(`Failed to start: ${e.message}`);
    updatePlayerStatus("stopped", `Error: ${e.message}`);
    showPlayButton(currentChannel ? "Play" : "Start");
  });
};

btnPrevStation.onclick = () => {
  const allStations = allExternalStations.filter((s) => {
    const c = streamStatusCache[s.streamUrl];
    return !c || c.ok;
  });
  if (!currentExternalStation || allStations.length === 0) return;
  const idx = allStations.findIndex((s) => s.streamUrl === currentExternalStation!.streamUrl);
  if (idx < 0) return;
  const prevIdx = (idx - 1 + allStations.length) % allStations.length;
  selectExternalStation(allStations[prevIdx]);
};

btnNextStation.onclick = () => {
  const allStations = allExternalStations.filter((s) => {
    const c = streamStatusCache[s.streamUrl];
    return !c || c.ok;
  });
  if (!currentExternalStation || allStations.length === 0) return;
  const idx = allStations.findIndex((s) => s.streamUrl === currentExternalStation!.streamUrl);
  if (idx < 0) return;
  const nextIdx = (idx + 1) % allStations.length;
  selectExternalStation(allStations[nextIdx]);
};

function sendChatMessage() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !token) return;
  const text = (chatInput.value || "").trim();
  if (!text) return;
  try {
    ws.send(JSON.stringify({ type: "chat", text }));
    chatInput.value = "";
  } catch (err) {
    console.error("Failed to send chat:", err);
  }
}

chatSendBtn.onclick = sendChatMessage;
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChatMessage();
  }
});

async function apiCall(endpoint: string, options: RequestInit = {}): Promise<any> {
  const url = `${API_URL}${endpoint}`;
  const headers: HeadersInit = { "Content-Type": "application/json", ...options.headers };
  if (token) {
    (headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

const authOverlay = document.getElementById("auth-overlay")!;
const authTabLogin = document.getElementById("auth-tab-login")!;
const authTabRegister = document.getElementById("auth-tab-register")!;
const authLoginForm = document.getElementById("auth-login-form")!;
const authRegisterForm = document.getElementById("auth-register-form")!;
const authLoginEmail = document.getElementById("auth-login-email")! as HTMLInputElement;
const authLoginPassword = document.getElementById("auth-login-password")! as HTMLInputElement;
const authRegisterEmail = document.getElementById("auth-register-email")! as HTMLInputElement;
const authRegisterPassword = document.getElementById("auth-register-password")! as HTMLInputElement;
const authError = document.getElementById("auth-error")!;
const authLoginBtn = document.getElementById("auth-login-btn")!;
const authRegisterBtn = document.getElementById("auth-register-btn")!;
const authClose = document.getElementById("auth-close")!;

function showAuthError(msg: string) {
  authError.textContent = msg;
  authError.classList.remove("hidden");
}
function hideAuthError() {
  authError.classList.add("hidden");
}

authTabLogin.onclick = () => {
  authTabLogin.classList.add("active");
  authTabRegister.classList.remove("active");
  authLoginForm.classList.remove("hidden");
  authRegisterForm.classList.add("hidden");
  hideAuthError();
};
authTabRegister.onclick = () => {
  authTabRegister.classList.add("active");
  authTabLogin.classList.remove("active");
  authRegisterForm.classList.remove("hidden");
  authLoginForm.classList.add("hidden");
  hideAuthError();
};

authLoginBtn.onclick = async () => {
  hideAuthError();
  const email = authLoginEmail.value.trim();
  const password = authLoginPassword.value;
  if (!email || !password) {
    showAuthError("Email and password required");
    return;
  }
  try {
    const result = await fetch(`${API_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!result.ok) {
      const err = await result.json().catch(() => ({}));
      showAuthError(err.error || "Login failed");
      return;
    }
    const data = await result.json();
    token = data.token;
    userEmail = data.user?.email ?? null;
    if (token) localStorage.setItem("laf_token", token);
    if (userEmail) localStorage.setItem("laf_user_email", userEmail);
    updateTopBarAuth();
    authOverlay.classList.remove("visible");
  } catch (err: any) {
    showAuthError(err.message || "Network error");
  }
};

authRegisterBtn.onclick = async () => {
  hideAuthError();
  const email = authRegisterEmail.value.trim();
  const password = authRegisterPassword.value;
  if (!email || !password) {
    showAuthError("Email and password required");
    return;
  }
  try {
    const result = await fetch(`${API_URL}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!result.ok) {
      const err = await result.json().catch(() => ({}));
      showAuthError(err.error || "Registration failed");
      return;
    }
    const data = await result.json();
    token = data.token;
    userEmail = data.user?.email ?? null;
    if (token) localStorage.setItem("laf_token", token);
    if (userEmail) localStorage.setItem("laf_user_email", userEmail);
    updateTopBarAuth();
    authOverlay.classList.remove("visible");
  } catch (err: any) {
    showAuthError(err.message || "Network error");
  }
};

authClose.onclick = () => authOverlay.classList.remove("visible");
document.getElementById("client-signin-link")!.addEventListener("click", (e) => {
  e.preventDefault();
  authOverlay.classList.add("visible");
});
function doLogout() {
  token = null;
  userEmail = null;
  localStorage.removeItem("laf_token");
  localStorage.removeItem("laf_user_email");
  updateTopBarAuth();
}
document.getElementById("client-logout-btn")!.onclick = doLogout;
document.getElementById("client-logout-btn-drawer")?.addEventListener("click", doLogout);
document.getElementById("client-signin-link-drawer")?.addEventListener("click", (e) => {
  e.preventDefault();
  closeMobileNav();
  authOverlay.classList.add("visible");
});

let onAdminViewShow: (() => void) | null = null;

// Load runtime config (API/relay URLs from /config.json) then start
function setActiveView(route: RouteId) {
  if (route === "admin" && !isAllowedAdmin()) {
    window.location.hash = "live";
    return;
  }
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const view = document.getElementById(`view-${route}`);
  if (view) view.classList.add("active");
  const navAbout = document.getElementById("nav-about");
  if (navAbout) navAbout.classList.toggle("active", route === "about");
  const navAdmin = document.getElementById("nav-admin");
  if (navAdmin) navAdmin.classList.toggle("active", route === "admin");
  const drawerAdmin = document.getElementById("drawer-admin");
  if (drawerAdmin) drawerAdmin.classList.toggle("active", route === "admin");
  if (topbarSearchWrap) topbarSearchWrap.classList.toggle("hidden", route !== "live");
  if (route === "admin") onAdminViewShow?.();
}

function updateThemeButtonText() {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "Light" : "Dark";
  const btn = document.getElementById("theme-toggle");
  const btnDrawer = document.getElementById("theme-toggle-drawer");
  if (btn) btn.textContent = next;
  if (btnDrawer) btnDrawer.textContent = next;
}
function initTheme() {
  const stored = localStorage.getItem("laf_theme") as "light" | "dark" | null;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = stored || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
  updateThemeButtonText();
  const toggle = () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("laf_theme", next);
    updateThemeButtonText();
  };
  document.getElementById("theme-toggle")?.addEventListener("click", toggle);
  document.getElementById("theme-toggle-drawer")?.addEventListener("click", toggle);
}
function closeMobileNav() {
  document.body.classList.remove("nav-open");
  const menuToggle = document.getElementById("menu-toggle");
  if (menuToggle) menuToggle.setAttribute("aria-expanded", "false");
}
function initMobileNav() {
  const menuToggle = document.getElementById("menu-toggle");
  const backdrop = document.getElementById("nav-backdrop");
  const drawer = document.getElementById("nav-drawer");
  menuToggle?.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    menuToggle.setAttribute("aria-expanded", String(open));
  });
  backdrop?.addEventListener("click", closeMobileNav);
  drawer?.querySelectorAll("a.topbar-nav-item").forEach((a) => {
    a.addEventListener("click", () => { closeMobileNav(); });
  });
}

function applyStationsSearch() {
  const v = (stationsSearchTopbar?.value ?? "").trim();
  stationsSearchQuery = v;
  if (stationsSearchTopbar) stationsSearchTopbar.value = v;
  renderUnifiedStations();
}

function initAdminForm() {
  const submitBtn = document.getElementById("admin-submit-btn");
  const statusEl = document.getElementById("admin-status");
  const urlInput = document.getElementById("admin-url") as HTMLInputElement | null;
  const listEl = document.getElementById("admin-stations-list");
  if (!submitBtn || !statusEl || !urlInput) return;

  function showAdminStatus(message: string, isError: boolean) {
    statusEl.textContent = message;
    statusEl.classList.toggle("hidden", !message);
    statusEl.classList.toggle("status-error", isError);
    statusEl.classList.toggle("status-info", !isError);
  }

  type AdminStationRow = { id?: string; name: string; description?: string | null; streamUrl: string; websiteUrl?: string; logoUrl?: string | null };
  async function loadAdminStationsList() {
    if (!listEl) return;
    try {
      const res = await fetch(`${API_URL}/api/external-stations`);
      const apiRows = (await res.json()) as AdminStationRow[];
      const builtIn = getBuiltInStationsFlat();
      const byStreamUrl = new Map<string, AdminStationRow>();
      for (const r of apiRows) {
        if (r.streamUrl) byStreamUrl.set(r.streamUrl, { ...r, websiteUrl: r.websiteUrl ?? r.streamUrl });
      }
      for (const s of builtIn) {
        if (!byStreamUrl.has(s.streamUrl)) {
          byStreamUrl.set(s.streamUrl, {
            name: s.name,
            description: s.description || null,
            streamUrl: s.streamUrl,
            websiteUrl: s.websiteUrl,
            logoUrl: s.logoUrl || null,
          });
        }
      }
      let allRows = Array.from(byStreamUrl.values()).sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
      allRows = allRows.filter((r) => !stationOverrides[r.streamUrl]?.hidden);
      listEl.innerHTML = "";
      if (!allRows.length) {
        listEl.innerHTML = "<p style='color: var(--text-muted); font-size: 13px;'>No stations.</p>";
        return;
      }
      for (const row of allRows) {
        const display = applyStationOverride({ ...row }, row.streamUrl);
        const div = document.createElement("div");
        div.className = "admin-station-row";
        const info = document.createElement("div");
        info.style.cssText = "min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px;";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = display.name || "Unnamed";
        const streamUrl = document.createElement("span");
        streamUrl.className = "stream-url";
        streamUrl.textContent = row.streamUrl || "";
        info.appendChild(name);
        info.appendChild(streamUrl);
        const btnWrap = document.createElement("div");
        btnWrap.style.cssText = "display: flex; gap: 8px; flex-shrink: 0; align-items: center;";
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => {
          if (div.querySelector(".admin-station-edit-form")) return;
          const form = document.createElement("div");
          form.className = "admin-station-edit-form";
          form.innerHTML = `
            <div class="form-group"><label>Name</label><input type="text" data-field="name" value="${escapeAttr(display.name || "")}" /></div>
            <div class="form-group"><label>Description</label><textarea data-field="description" rows="2">${escapeHtml(display.description || "")}</textarea></div>
            <div class="form-group"><label>Website URL</label><input type="url" data-field="websiteUrl" value="${escapeAttr(display.websiteUrl || "")}" /></div>
            <div class="form-group"><label>Logo URL</label><input type="url" data-field="logoUrl" value="${escapeAttr(display.logoUrl || "")}" placeholder="https://..." /></div>
            <div style="display:flex;gap:8px;margin-top:8px;">
              <button type="button" class="admin-edit-save">Save</button>
              <button type="button" class="admin-edit-cancel">Cancel</button>
            </div>
          `;
          form.style.cssText = "grid-column: 1 / -1; padding: 12px; border-top: 1px solid var(--border); margin-top: 8px; background: var(--bg);";
          const saveBtn = form.querySelector(".admin-edit-save")!;
          const cancelBtn = form.querySelector(".admin-edit-cancel")!;
          cancelBtn.addEventListener("click", () => { form.remove(); });
          saveBtn.addEventListener("click", async () => {
            const nameVal = (form.querySelector("[data-field=name]") as HTMLInputElement)?.value?.trim() || "";
            const descVal = (form.querySelector("[data-field=description]") as HTMLTextAreaElement)?.value?.trim() || "";
            const webVal = (form.querySelector("[data-field=websiteUrl]") as HTMLInputElement)?.value?.trim() || "";
            const logoVal = (form.querySelector("[data-field=logoUrl]") as HTMLInputElement)?.value?.trim() || "";
            if (!nameVal) { alert("Name is required"); return; }
            (saveBtn as HTMLButtonElement).setAttribute("disabled", "true");
            try {
              if (row.id) {
                const patchRes = await fetch(`${API_URL}/api/external-stations/${row.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                  body: JSON.stringify({ name: nameVal, description: descVal || undefined, websiteUrl: webVal || undefined, logoUrl: logoVal || undefined }),
                });
                if (patchRes.ok) {
                  form.remove();
                  await loadAdminStationsList();
                  await loadExternalStations();
                } else {
                  const data = (await patchRes.json().catch(() => ({}))) as { error?: string };
                  alert(data.error || "Failed to update");
                }
              } else {
                const overrideRes = await fetch(`${API_URL}/api/station-overrides`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                  body: JSON.stringify({ streamUrl: row.streamUrl, name: nameVal, description: descVal || undefined, websiteUrl: webVal || undefined, logoUrl: logoVal || undefined }),
                });
                if (overrideRes.ok) {
                  form.remove();
                  await loadAdminStationsList();
                  await loadExternalStations();
                } else {
                  const data = (await overrideRes.json().catch(() => ({}))) as { error?: string };
                  alert(data.error || "Failed to save");
                }
              }
            } finally {
              (saveBtn as HTMLButtonElement).removeAttribute("disabled");
            }
          });
          div.appendChild(form);
        });
        btnWrap.appendChild(editBtn);
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", async () => {
          if (!token) return;
          if (!confirm(`Remove "${display.name || "this station"}" from the site?`)) return;
          delBtn.setAttribute("disabled", "true");
          try {
            if (row.id) {
              const delRes = await fetch(`${API_URL}/api/external-stations/${row.id}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
              });
              if (delRes.ok) {
                await loadAdminStationsList();
                await loadExternalStations();
              } else {
                const data = (await delRes.json().catch(() => ({}))) as { error?: string };
                alert(data.error || "Failed to delete");
              }
            } else {
              const overrideRes = await fetch(`${API_URL}/api/station-overrides`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ streamUrl: row.streamUrl, hidden: true }),
              });
              if (overrideRes.ok) {
                await loadAdminStationsList();
                await loadExternalStations();
              } else {
                const data = (await overrideRes.json().catch(() => ({}))) as { error?: string };
                alert(data.error || "Failed to remove");
              }
            }
          } finally {
            delBtn.removeAttribute("disabled");
          }
        });
        btnWrap.appendChild(delBtn);
        div.appendChild(info);
        div.appendChild(btnWrap);
        listEl.appendChild(div);
      }
    } catch (_) {
      listEl.innerHTML = "<p style='color: var(--status-offline); font-size: 13px;'>Failed to load list.</p>";
    }
  }

  submitBtn.addEventListener("click", async () => {
    const url = (urlInput.value ?? "").trim();
    if (!url) {
      showAdminStatus("Enter a website or stream URL.", true);
      return;
    }
    if (!token) {
      showAdminStatus("Sign in to add stations.", true);
      return;
    }
    submitBtn.setAttribute("disabled", "true");
    showAdminStatus("Resolving URL and checking stream…", false);
    try {
      const res = await fetch(`${API_URL}/api/external-stations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url }),
      });
      if (res.ok) {
        showAdminStatus("Station added. It will appear in Live when the stream is reachable.", false);
        urlInput.value = "";
        await loadAdminStationsList();
        await loadExternalStations();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        showAdminStatus(data.error || res.statusText || "Failed to add station.", true);
      }
    } catch (e) {
      showAdminStatus(e instanceof Error ? e.message : "Network error.", true);
    } finally {
      submitBtn.removeAttribute("disabled");
    }
  });

  onAdminViewShow = loadAdminStationsList;
}

loadRuntimeConfig().then(() => {
  applyBroadcastLink();
  updateTopBarAuth();
  initTheme();
  initMobileNav();
  initAdminForm();
  initRouter((route) => setActiveView(route));
  setActiveView(getRoute());
  loadExternalStations();
  if (token) loadFavorites().then(() => renderUnifiedStations());
  loadChannels();
  setInterval(loadChannels, 15000);
  setInterval(() => {
    clearStreamStatusCache();
    runFullStreamCheck();
  }, STREAM_RECHECK_INTERVAL_MS);
  stationsSearchTopbar?.addEventListener("input", applyStationsSearch);
  favoritesFilter?.addEventListener("change", () => renderUnifiedStations());
  if (favoritesFilterWrap && !token) favoritesFilterWrap.classList.add("hidden");
});
