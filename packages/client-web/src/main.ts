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
  /** City/country or place name for display and map. */
  location?: string;
  /** Latitude for world map mode (e.g. 52.52). */
  lat?: number;
  /** Longitude for world map mode (e.g. 13.405). */
  lng?: number;
}

/** Station config: single stream or multiple channels (e.g. SomaFM). */
interface ExternalStationConfig {
  name: string;
  description: string;
  websiteUrl: string;
  streamUrl: string;
  logoUrl: string;
  /** City/country or place name. */
  location?: string;
  /** Latitude for world map (optional). */
  lat?: number;
  /** Longitude for world map (optional). */
  lng?: number;
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
    location: "Berlin, Germany",
    lat: 52.52,
    lng: 13.405,
  },
  {
    name: "Mutant Radio",
    description: "Independent station streaming worldwide. Experimental, electronic, folk.",
    websiteUrl: "https://www.mutantradio.net/",
    streamUrl: "https://listen.radioking.com/radio/282820/stream/328621",
    logoUrl: "https://www.mutantradio.net/icon?e5faaecf67dfe01a",
    location: "Worldwide",
  },
  {
    name: "Radio 80000",
    description: "Non-commercial online radio from Munich. Music, dialogue, events.",
    websiteUrl: "https://www.radio80k.de/",
    streamUrl: "https://radio80k.out.airtime.pro:8000/radio80k_a",
    logoUrl: "https://www.radio80k.de/app/uploads/2022/10/cropped-favicon-8000-192x192.gif",
    location: "Munich, Germany",
    lat: 48.1351,
    lng: 11.582,
  },
  // From Are.na channel online-radios-zlvblzsstly; stream URLs from Radio Browser API / official sites
  {
    name: "KEXP 90.3 FM",
    description: "Where the Music Matters. Seattle-based listener-supported radio.",
    websiteUrl: "https://www.kexp.org/",
    streamUrl: "https://kexp.streamguys1.com/kexp160.aac",
    logoUrl: "https://www.kexp.org/favicon.ico",
    location: "Seattle, USA",
    lat: 47.6062,
    lng: -122.3321,
  },
  {
    name: "SomaFM",
    description: "Listener-supported, commercial-free internet radio. Multiple channels.",
    websiteUrl: "http://soma.fm/",
    streamUrl: "https://ice5.somafm.com/live-128-mp3",
    logoUrl: "https://somafm.com/img/somafm-logo-square.png",
    location: "San Francisco, USA",
    lat: 37.7749,
    lng: -122.4194,
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
    location: "Jersey City, USA",
    lat: 40.7178,
    lng: -74.0431,
  },
  {
    name: "NTS Radio",
    description: "Don't Assume. Two live channels, 24/7.",
    websiteUrl: "https://www.nts.live/",
    streamUrl: "https://stream-relay-geo.ntslive.net/stream",
    logoUrl: "https://www.nts.live/favicon.ico",
    location: "London, UK",
    lat: 51.5074,
    lng: -0.1278,
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
    location: "Lyon, France",
    lat: 45.764,
    lng: 4.8357,
  },
  {
    name: "Noods Radio",
    description: "Independent radio broadcasting from Bristol. Electronic, experimental, dub.",
    websiteUrl: "https://noodsradio.com/",
    streamUrl: "https://stream.noodsradio.com/stream",
    logoUrl: "https://noodsradio.com/favicon.ico",
    location: "Bristol, UK",
    lat: 51.4545,
    lng: -2.5879,
  },
  {
    name: "Veneno",
    description: "Radio online vanguarda. São Paulo-based station. New music, electronic, Brazilian, house, techno and more.",
    websiteUrl: "https://veneno.live/",
    streamUrl: "https://veneno.out.airtime.pro/veneno_a",
    logoUrl: "https://veneno.live/wp-content/uploads/2024/02/veneno-v.svg",
    location: "São Paulo, Brazil",
    lat: -23.5505,
    lng: -46.6333,
  },
  {
    name: "Kiosk Radio",
    description: "24/7 from a wooden kiosk in Brussels' Parc Royal. Eclectic music from DJs and artists.",
    websiteUrl: "https://kioskradio.com/",
    streamUrl: "https://kioskradiobxl.out.airtime.pro/kioskradiobxl_b",
    logoUrl: "https://kioskradio.com/favicon.ico",
    location: "Brussels, Belgium",
    lat: 50.8503,
    lng: 4.3517,
  },
  {
    name: "KCHUNG Radio",
    description: "1630 AM Chinatown Los Angeles. Community radio.",
    websiteUrl: "http://kchungradio.org/",
    streamUrl: "http://stream.kchungradio.org:8000/stream",
    logoUrl: "http://kchungradio.org/favicon.ico",
    location: "Los Angeles, USA",
    lat: 34.0522,
    lng: -118.2437,
  },
  {
    name: "Tikka Radio",
    description: "Online radio.",
    websiteUrl: "https://tikka.live/",
    streamUrl: "https://stream.tikka.live/live",
    logoUrl: "https://tikka.live/favicon.ico",
    location: "Tokyo, Japan",
    lat: 35.6762,
    lng: 139.6503,
  },
  {
    name: "WOBC Chameleon Radio",
    description: "Oberlin College student-run freeform radio. 91.5 FM, 24/7.",
    websiteUrl: "https://wobc.stream/",
    streamUrl: "https://wobc.stream/stream",
    logoUrl: "https://wobc.stream/favicon.ico",
    location: "Oberlin, USA",
    lat: 41.2932,
    lng: -82.2174,
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
    location: "London, UK",
    lat: 51.5074,
    lng: -0.1278,
  },
  {
    name: "Tsubaki FM",
    description: "Internet radio from Tokyo, Kyoto, Nagoya. Funk, jazz, soul, electronic, disco, world music.",
    websiteUrl: "https://tsubakifm.com/",
    streamUrl: "https://tsubakifm.out.airtime.pro/tsubakifm_a",
    logoUrl: "https://tsubakifm.com/favicon.ico",
    location: "Tokyo, Japan",
    lat: 35.6762,
    lng: 139.6503,
  },
  {
    name: "Radio Nopal",
    description: "Community radio. Eclectic sounds and voices.",
    websiteUrl: "https://www.radionopal.com/",
    streamUrl: "https://radionopal.out.airtime.pro/radionopal_a",
    logoUrl: "https://www.radionopal.com/favicon.ico",
    location: "Online",
  },
  {
    name: "Good Times Bad Times",
    description: "Community radio at Extra Practice. Good times, bad times.",
    websiteUrl: "https://goodtimesbadtimes.club/",
    streamUrl: "https://radio.goodtimesbadtimes.club/radio/8000/radio.mp3",
    logoUrl: "https://goodtimesbadtimes.club/favicon.ico",
    location: "Online",
  },
  {
    name: "Radio Robida",
    description: "Robida collective radio. Ambient, programme and walkie-talkie channels.",
    websiteUrl: "https://radio.robidacollective.com/",
    streamUrl: "https://radio.robidacollective.com/stream/programme",
    logoUrl: "https://radio.robidacollective.com/favicon.ico",
    location: "Slovenia",
  },
  {
    name: "Yamakan Palestine",
    description: "Radio from Yamakan. Palestine.",
    websiteUrl: "https://yamakan.place/palestine/",
    streamUrl: "https://yamakan.out.airtime.pro/yamakan_a",
    logoUrl: "https://yamakan.place/favicon.ico",
    location: "Bethlehem, Palestine",
    lat: 31.7054,
    lng: 35.2022,
  },
  {
    name: "Radio Centraal",
    description: "Independent non-commercial FM radio. Antwerp 106.7 FM. Music, poetry, film, culture.",
    websiteUrl: "https://www.radiocentraal.be/",
    streamUrl: "http://streams.movemedia.eu/centraal",
    logoUrl: "https://www.radiocentraal.be/favicon.ico",
    location: "Antwerp, Belgium",
    lat: 51.2213,
    lng: 4.4055,
  },
  {
    name: "Area 3000",
    description: "24/7 digital radio from Naarm/Melbourne. Underground music, DJ sets, podcasts. Revolver Lane, Wurundjeri land.",
    websiteUrl: "https://area3000.radio/",
    streamUrl: "https://stream.radiocult.fm/area-3000",
    logoUrl: "https://area3000.radio/cdn/shop/files/Area_3000_Logo_Black.png?v=1704440747",
    location: "Melbourne, Australia",
    lat: -37.8136,
    lng: 144.9631,
  },
  {
    name: "Cashmere Radio",
    description: "Experimental radio station, Berlin. 88.4 FM Berlin, 90.7 Potsdam. Electronic, ambient, experimental.",
    websiteUrl: "https://cashmereradio.com/",
    streamUrl: "https://cashmereradio.out.airtime.pro/cashmereradio_b",
    logoUrl: "https://cashmereradio.com/favicon.ico",
    location: "Berlin, Germany",
    lat: 52.52,
    lng: 13.405,
  },
  {
    name: "Radio Campus Brussels",
    description: "Student radio. Brussels 92.1 FM. Jazz, alternative, rock, electronic, folk, hip-hop.",
    websiteUrl: "https://www.radiocampus.be/",
    streamUrl: "https://stream.radiocampus.be/stream",
    logoUrl: "https://www.radiocampus.be/favicon.ico",
    location: "Brussels, Belgium",
    lat: 50.8503,
    lng: 4.3517,
  },
  {
    name: "Black Rhino Radio",
    description: "Electronic, reggae, dub, techno, jazz, hip hop. Live radio.",
    websiteUrl: "https://blackrhinoradio.com/",
    streamUrl: "https://blackrhinoradio.out.airtime.pro/blackrhinoradio_a",
    logoUrl: "https://blackrhinoradio.com/favicon.ico",
    location: "Online",
  },
  {
    name: "Radio Aparat",
    description: "Eclectic online radio from Belgrade. Guitar music, electronics, indie.",
    websiteUrl: "https://radioaparat.rs/",
    streamUrl: "https://stream4.rcast.net/72355/",
    logoUrl: "https://radioaparat.rs/favicon.ico",
    location: "Belgrade, Serbia",
    lat: 44.7866,
    lng: 20.4489,
  },
  {
    name: "dublab",
    description: "Non-profit listener-powered radio. Los Angeles. Experimental electronica, jazz funk, indie, hip-hop, dub.",
    websiteUrl: "https://www.dublab.com/",
    streamUrl: "https://dublab.out.airtime.pro/dublab_a",
    logoUrl: "https://www.dublab.com/favicon.ico",
    location: "Los Angeles, USA",
    lat: 34.0522,
    lng: -118.2437,
  },
  {
    name: "RUKH",
    description: "Non-commercial DIY community radio from Odesa, Ukraine. Alternative and experimental music, subcultures.",
    websiteUrl: "https://rukh.live/",
    streamUrl: "https://rukh.out.airtime.pro/rukh_a",
    logoUrl: "https://rukh.live/favicon.ico",
    location: "Odesa, Ukraine",
    lat: 46.4825,
    lng: 30.7233,
  },
  {
    name: "Radio Helsinki",
    description: "Community radio. Graz, Austria 92.6 MHz. Independent, non-commercial.",
    websiteUrl: "https://helsinki.at/",
    streamUrl: "https://live.helsinki.at:8088/live160.mp3",
    logoUrl: "https://helsinki.at/favicon.ico",
    location: "Graz, Austria",
    lat: 47.0707,
    lng: 15.4395,
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
    websiteUrl: "https://www.radioalhara.net/",
    streamUrl: "https://n02.radiojar.com/78cxy6wkxtzuv",
    logoUrl: "https://www.radioalhara.net/img/radio-alhara-logo.svg",
    location: "Bethlehem, Palestine",
    lat: 31.7054,
    lng: 35.2022,
  },
  {
    name: "The Lake Radio",
    description: "Independent online community radio from Copenhagen. Experimental, alternative, avant-garde music and sound art 24/7.",
    websiteUrl: "https://thelakeradio.com/",
    streamUrl: "https://thelakeradio.out.airtime.pro/thelakeradio_a",
    logoUrl: "https://thelakeradio.com/favicon.ico",
    location: "Copenhagen, Denmark",
    lat: 55.6761,
    lng: 12.5683,
  },
  // 30 more underground/community/experimental stations (Radio Browser API, station sites)
  {
    name: "aNONradio",
    description: "Community-run station from the SDF Public Access UNIX System. Eclectic, experimental, non-commercial.",
    websiteUrl: "https://anonradio.net/",
    streamUrl: "http://anonradio.net:8000/anonradio",
    logoUrl: "https://anonradio.net/favicon.ico",
    location: "USA",
  },
  {
    name: "DFM RTV INT",
    description: "Artist-run station from Amsterdam. No ads, no tracking. Experimental, electronic, underground 24/7.",
    websiteUrl: "https://dfm.nu/",
    streamUrl: "http://213.133.109.221:8205/dfm_1",
    logoUrl: "https://dfm.nu/favicon.ico",
    location: "Amsterdam, Netherlands",
    lat: 52.3676,
    lng: 4.9041,
  },
  {
    name: "CROP Radio",
    description: "Community radio from Manchester. Underground and variety.",
    websiteUrl: "https://www.cropradio.live/",
    streamUrl: "https://s3.radio.co/sb713b671e/listen",
    logoUrl: "https://www.cropradio.live/images/favicons/apple-touch-icon.png",
    location: "Manchester, UK",
    lat: 53.4808,
    lng: -2.2426,
  },
  {
    name: "Deja Vu FM",
    description: "Underground radio. Eclectic sounds.",
    websiteUrl: "https://dejavufm.com/",
    streamUrl: "https://dejavufm.radioca.st/",
    logoUrl: "https://dejavufm.com/wp-content/uploads/deja-pic-logo-.jpg",
    location: "UK",
  },
  {
    name: "Divine Radio London",
    description: "Electronic and underground DJ mixes from London.",
    websiteUrl: "https://www.divineradiolondon.co.uk/",
    streamUrl: "https://uk2.internet-radio.com/proxy/divinestream?mp=/stream",
    logoUrl: "https://www.divineradiolondon.co.uk/favicon.ico",
    location: "London, UK",
    lat: 51.5074,
    lng: -0.1278,
  },
  {
    name: "Drop FM",
    description: "Listener-supported bass and underground from Southern Lakes, New Zealand.",
    websiteUrl: "http://www.dropfm.com/",
    streamUrl: "https://s2.radio.co/s7649837db/listen",
    logoUrl: "http://www.dropfm.com/uploads/1/2/4/0/124005161/new-logo-black.png",
    location: "New Zealand",
  },
  {
    name: "Echo Park Radio",
    description: "Community radio from Los Angeles. Eclectic, underground.",
    websiteUrl: "http://www.echoparkradio.com/",
    streamUrl: "http://104.63.241.231:8000/listen",
    logoUrl: "http://www.echoparkradio.com/favicon.ico",
    location: "Los Angeles, USA",
    lat: 34.0522,
    lng: -118.2437,
  },
  {
    name: "Abusia Radio",
    description: "Afro, deep house, disco, funk, jazz, soulful house, tech house, techno. No ads.",
    websiteUrl: "http://www.abusiaradio.com/",
    streamUrl: "https://ice66.securenetsystems.net/ABUSIA",
    logoUrl: "https://abusiaradio.com/wp-content/uploads/2024/06/cropped-abusia-radio_new-site-logo_pro-radio-180x180.png",
    location: "USA",
  },
  {
    name: "Kamikaze Radio",
    description: "Alternative, punk, ska, underground from Germany.",
    websiteUrl: "http://www.kamikaze-radio.de/",
    streamUrl: "http://streamplus52.leonex.de:10894/",
    logoUrl: "http://www.kamikaze-radio.de/favicon.ico",
    location: "Germany",
  },
  {
    name: "Kanal 103",
    description: "Freeform radio from North Macedonia. Alternative, dance, electronic, indie, pop rock.",
    websiteUrl: "http://kanal103.com.mk/",
    streamUrl: "http://radiostream.neotel.mk/kanal103",
    logoUrl: "http://kanal103.com.mk/favicon.ico",
    location: "North Macedonia",
  },
  {
    name: "KWSX",
    description: "Experimental, leftfield techno, vaporwave. From the Cock Institute.",
    websiteUrl: "https://radio.cock.institute/",
    streamUrl: "https://radioadmin.kwsx.online/listen/kwsx/radio.mp3",
    logoUrl: "https://radio.cock.institute/assets/favicon/android-chrome-512x512.png",
    location: "USA",
  },
  {
    name: "Lumbung Radio",
    description: "Inter-local community radio. documenta fifteen. Alternative, arts, electronic, improvisation.",
    websiteUrl: "https://lumbungradio.stationofcommons.org/",
    streamUrl: "http://lumbungradio.stationofcommons.org:8000/128.mp3",
    logoUrl: "https://lumbungradio.stationofcommons.org/favicon.ico",
    location: "International",
  },
  {
    name: "movement.radio",
    description: "Athens-based. Ambient, bass, electro, experimental, hip-hop, jazz, synth, underground, world.",
    websiteUrl: "http://www.movement.radio/",
    streamUrl: "https://movementathens.out.airtime.pro/movementathens_a",
    logoUrl: "http://www.movement.radio/favicon.ico",
    location: "Athens, Greece",
    lat: 37.9838,
    lng: 23.7275,
  },
  {
    name: "NimFM",
    description: "Alternative, topical, underground talk and music from Australia.",
    websiteUrl: "https://www.nimfm.org/",
    streamUrl: "http://uk5.internet-radio.com:8055/stream",
    logoUrl: "https://www.nimfm.org/favicon.ico",
    location: "Australia",
  },
  {
    name: "Offradio Kraków",
    description: "Underground radio from Kraków.",
    websiteUrl: "https://off.radiokrakow.pl/",
    streamUrl: "http://stream4.nadaje.com:13332/offradiokrakow",
    logoUrl: "https://off.radiokrakow.pl/img/icons/apple-touch-icon-152x152.png",
    location: "Kraków, Poland",
    lat: 50.0647,
    lng: 19.945,
  },
  {
    name: "Playground Radio",
    description: "Dark, darkwave, underground. Germany.",
    websiteUrl: "https://laut.fm/playground",
    streamUrl: "https://stream.laut.fm/playground",
    logoUrl: "https://i.imgur.com/4PHo6HB.png",
    location: "Germany",
  },
  {
    name: "10 Radio",
    description: "Community radio. Somerset, Wiveliscombe.",
    websiteUrl: "http://10radio.org/",
    streamUrl: "http://live.canstream.co.uk:8000/10radio.mp3",
    logoUrl: "http://10radio.org/favicon.ico",
    location: "Somerset, UK",
  },
  {
    name: "Ad Infinitum",
    description: "Ambient, black metal, electronic, experimental.",
    websiteUrl: "https://laut.fm/ad_infinitum",
    streamUrl: "http://stream.laut.fm/ad_infinitum",
    logoUrl: "https://laut.fm/favicon.ico",
    location: "Online",
  },
  {
    name: "Basspistol Radio",
    description: "Dance, electronic, experimental, hip-hop, indie from Switzerland.",
    websiteUrl: "https://basspistol.com/radio",
    streamUrl: "https://radio.basspistol.com/radio.mp3",
    logoUrl: "https://basspistol.com/siteicon.png",
    location: "Switzerland",
  },
  {
    name: "bauhaus.fm",
    description: "Bauhaus University Weimar. Experimental, slow radio, sound art.",
    websiteUrl: "https://www.uni-weimar.de/projekte/bauhaus-fm",
    streamUrl: "http://bauhaus.fm:8000/_a",
    logoUrl: "https://www.uni-weimar.de/projekte/bauhaus-fm/wp-content/uploads/2018/11/cropped-3667_4_bauhaus-fm-logo_1024.jpg",
    location: "Weimar, Germany",
  },
  {
    name: "Concertzender X-Rated",
    description: "Ambient, avant-garde, electronics, experimental, industrial. Netherlands.",
    websiteUrl: "https://www.concertzender.nl/",
    streamUrl: "http://streams.greenhost.nl:8080/concertzenderlive",
    logoUrl: "https://www.concertzender.nl/favicon.ico",
    location: "Netherlands",
  },
  {
    name: "Chercan Radio",
    description: "Ambient, experimental, noise, sound art from Valparaíso, Chile.",
    websiteUrl: "https://ratasordarec.cl/radio/",
    streamUrl: "https://stream.zeno.fm/es9h0crh74zuv",
    logoUrl: "https://ratasordarec.cl/favicon.ico",
    location: "Valparaíso, Chile",
  },
  {
    name: "Dark Wave Radomir",
    description: "Alternative, avantgarde, dark wave, EBM, experimental, new wave, noise, post-punk. Bulgaria.",
    websiteUrl: "https://dwr.radio/",
    streamUrl: "https://dwrstream.eu/",
    logoUrl: "https://dwr.radio/wp-content/uploads/2023/10/cropped-favicon.png",
    location: "Bulgaria",
  },
  {
    name: "bad radio",
    description: "Eclectic, experimental music. USA.",
    websiteUrl: "https://badradio.biz/",
    streamUrl: "http://server.badradio.biz:8000/stream",
    logoUrl: "https://badradio.biz/favicon.ico",
    location: "USA",
  },
  {
    name: "AmbientRadio (MRG.fm)",
    description: "Ambient, drone, downtempo, experimental, meditation. New York.",
    websiteUrl: "https://www.mrg.fm/",
    streamUrl: "http://listen.mrg.fm:8888/stream",
    logoUrl: "https://mrg.fm/img/ambientradio125.jpg",
    location: "USA",
  },
  {
    name: "Violeta Radio",
    description: "Community, feminist radio. 106.1 FM Mexico City. Non-commercial.",
    websiteUrl: "https://violetaradio.org/",
    streamUrl: "https://flujos.mazorca.org/violetaradio.mp3",
    logoUrl: "https://violetaradio.org/favicon.ico",
    location: "Mexico City, Mexico",
    lat: 19.4326,
    lng: -99.1332,
  },
  {
    name: "Resonance FM",
    description: "London's arts radio. 104.4 FM. Non-commercial, experimental, artist-run.",
    websiteUrl: "https://www.resonancefm.com/",
    streamUrl: "http://stream.resonance.fm:8000/resonance.m3u",
    logoUrl: "https://www.resonancefm.com/favicon.ico",
    location: "London, UK",
    lat: 51.5074,
    lng: -0.1278,
  },
  {
    name: "Diffusion FM",
    description: "DIY experimental, sound art, soundscape. Australia.",
    websiteUrl: "https://diffusionfm.wordpress.com/",
    streamUrl: "https://giss.tv:666/diffusionfm919.mp3",
    logoUrl: "https://diffusionfm.wordpress.com/favicon.ico",
    location: "Australia",
  },
  {
    name: "Bit Express Digital Radio",
    description: "Experimental radio from Erlangen, Germany.",
    websiteUrl: "https://www.bitexpress.de/",
    streamUrl: "http://streaming.bitexpress.de:8010/heaac",
    logoUrl: "https://www.bitexpress.de/favicon.ico",
    location: "Erlangen, Germany",
  },
  {
    name: "Akademieradio",
    description: "Arts, culture, experimental, fine arts. Bavaria, Germany.",
    websiteUrl: "http://akademieradio.de/",
    streamUrl: "http://akademieradio.de/play",
    logoUrl: "http://akademieradio.de/favicon.ico",
    location: "Germany",
  },
  // 100 underground/community/experimental/freeform stations from Radio Browser API
  { name: "WeRave Music Radio 01", description: "Dark and underground electronic. New York.", websiteUrl: "https://werave.com.br/en", streamUrl: "https://stream.zeno.fm/pjktyby8dn5tv", logoUrl: "https://werave.com.br/wp-content/uploads/cropped-weravemusic-180x180.png", location: "New York, USA" },
  { name: "Ultra Dark Radio", description: "Darkwave, EBM, gothic, industrial, new wave.", websiteUrl: "http://www.ultradarkradio.com/", streamUrl: "http://stream.laut.fm/ultradarkradio", logoUrl: "", location: "Germany" },
  { name: "WeRave Music Radio 02", description: "Study and chillout. Melodic house, organic house.", websiteUrl: "https://werave.com.br/en", streamUrl: "https://stream.zeno.fm/cpnv07rjvp0vv", logoUrl: "https://werave.com.br/wp-content/uploads/2020/09/vinyl.png", location: "New York, USA" },
  { name: "Radio Free Phoenix", description: "60s–90s, alternative, commercial-free freeform rock.", websiteUrl: "http://radiofreephoenix.com/", streamUrl: "http://69.162.73.34:8124/;stream.nsv", logoUrl: "", location: "USA" },
  { name: "UnderGRAND Radio", description: "Alternative, blues, funk, jazz, metal, post rock, punk. Serbia.", websiteUrl: "https://undergrandradio.dotkomsite.com/", streamUrl: "http://stream.zeno.fm/rp1swb5pgzzuv", logoUrl: "https://img.sedoparking.com/templates/logos/sedo_logo.png", location: "Serbia" },
  { name: "Radio Underground Poland", description: "Independent punk, post-punk, reggae, ska. Poland.", websiteUrl: "http://www.radiounderground.org/", streamUrl: "http://s1.slotex.pl:7604/", logoUrl: "http://www.radiounderground.org/favicon.png", location: "Poland" },
  { name: "Start FM 94.2", description: "Underground radio. Vilnius.", websiteUrl: "http://www.startfm.lt/", streamUrl: "http://eteris.startfm.lt/startfm.mp3", logoUrl: "", location: "Vilnius, Lithuania" },
  { name: "Radio Underground Italia", description: "Underground radio from Italy.", websiteUrl: "https://radiounderground.it/", streamUrl: "https://nr14.newradio.it:8707/stream", logoUrl: "https://radio-streaming.it/assets/image/radio/180/logo_con_scritta.jpg", location: "Italy" },
  { name: "Laut.FM 80er-Zone", description: "80s, dark wave, pop, underground.", websiteUrl: "http://laut.fm/80er-zone", streamUrl: "http://stream.laut.fm/80er-zone", logoUrl: "", location: "Germany" },
  { name: "Radio Caprice – Underground Rap", description: "Underground rap. Russia.", websiteUrl: "http://radcap.ru/undergroundrap.html", streamUrl: "http://79.111.14.76:8000/undergroundrap", logoUrl: "", location: "Russia" },
  { name: "Renegade Radio", description: "Breakbeat, house, jungle, underground. UK.", websiteUrl: "https://renegaderadio.co.uk/", streamUrl: "http://149.255.60.195:8085/stream", logoUrl: "", location: "UK" },
  { name: "SNAKEDANCE", description: "Alternative, doom, EBM, electronic, gothic, industrial.", websiteUrl: "https://laut.fm/snakedance", streamUrl: "http://stream.laut.fm/snakedance", logoUrl: "", location: "Germany" },
  { name: "Exclusively REM", description: "College rock, indie rock, jangle pop. American underground.", websiteUrl: "http://play.exclusive.radio/", streamUrl: "https://nl4.mystreaming.net/er/rem/icecast.audio", logoUrl: "http://play.exclusive.radio/static/assets/img/apple-icon-120x120.png", location: "UAE" },
  { name: "METALSCENA netRADIO", description: "Heavy metal, underground. Slovakia.", websiteUrl: "https://www.metalscena.sk/", streamUrl: "https://listen.radioking.com/radio/263218/stream/308365", logoUrl: "", location: "Slovakia" },
  { name: "RES FM", description: "Dance, deep, tech house, techno, underground. Portugal.", websiteUrl: "https://resfmradio.com/", streamUrl: "http://stream2.soundflux.eu:8440/stream", logoUrl: "https://resfmradio.com/wp-content/uploads/2021/09/Logo_RES-FM_Verde_2.png", location: "Portugal" },
  { name: "Radio Sputnik", description: "Electronic, house, techno, underground. Netherlands.", websiteUrl: "http://www.radiosputnik.nl/", streamUrl: "http://radiosputnik.nl:8002/flac", logoUrl: "http://www.radiosputnik.nl/assets/images/apple-icon-120x120.png", location: "Netherlands" },
  { name: "RTBF Classic 21 – Underground", description: "Underground stream. Belgium.", websiteUrl: "https://www.rtbf.be/radio/liveradio/webradio-classic21-underground", streamUrl: "https://radios.rtbf.be/wr-c21-underground-128.mp3", logoUrl: "https://www.rtbf.be/favicon.ico", location: "Belgium" },
  { name: "Drop FM", description: "Bass, listener-supported underground. New Zealand.", websiteUrl: "http://www.dropfm.com/", streamUrl: "https://s2.radio.co/s7649837db/listen", logoUrl: "http://www.dropfm.com/uploads/1/2/4/0/124005161/new-logo-black.png", location: "New Zealand" },
  { name: "WIDE Radio", description: "Club, dance, electronic, grime, hip-hop, R&B, underground.", websiteUrl: "http://itswide.com/", streamUrl: "http://stream.radiojar.com/65s5r7weh24tv.mp3", logoUrl: "", location: "" },
  { name: "Radio Flouka", description: "Arab, underground. Paris.", websiteUrl: "https://www.radioflouka.com/", streamUrl: "https://flouka.out.airtime.pro/flouka_a", logoUrl: "https://www.radioflouka.com/favicon.ico", location: "Paris, France" },
  { name: "NimFM", description: "Alternative, talk, topical, underground. Australia.", websiteUrl: "https://www.nimfm.org/", streamUrl: "http://uk5.internet-radio.com:8055/stream", logoUrl: "", location: "Australia" },
  { name: "Underground Radio Czech", description: "Underground. Czech Republic.", websiteUrl: "http://www.undergroundradio.cz/", streamUrl: "http://icecast2.play.cz/Underground128.mp3", logoUrl: "", location: "Czech Republic" },
  { name: "Rundfunkautist", description: "Non-commercial, eclectic, experimental, underground. Germany.", websiteUrl: "http://rundfunkautist.bplaced.net/", streamUrl: "https://stream.laut.fm/rundfunkautist", logoUrl: "https://api.laut.fm/station/rundfunkautist/images/station", location: "Germany" },
  { name: "GDS.FM", description: "Acid house, experimental, hip-hop, indie rock, nu-jazz, trip hop. Zürich.", websiteUrl: "http://www.gds.fm/", streamUrl: "http://gdsfm.out.airtime.pro:8000/gdsfm_a", logoUrl: "http://www.gds.fm/_nuxt/icons/icon_64x64.96821f.png", location: "Zürich, Switzerland" },
  { name: "NEU RADIO", description: "Afrobeats, ambient, experimental, indie, minimal wave. Italy.", websiteUrl: "https://www.neuradio.it/", streamUrl: "https://nr9.newradio.it/proxy/ebaruffa?mp=/stream", logoUrl: "", location: "Italy" },
  { name: "Fluid Radio", description: "Abstract, acoustic, ambient, experimental, modern classical. UK.", websiteUrl: "http://www.fluid-radio.co.uk/", streamUrl: "http://uk4-vn.webcast-server.net:9270/", logoUrl: "", location: "UK" },
  { name: "EBM", description: "Dark wave, EBM, electronic, industrial, new wave. Germany.", websiteUrl: "https://flatlinesradio.de/", streamUrl: "https://stream.laut.fm/ebm", logoUrl: "https://i0.wp.com/flatlinesradio.de/storage/2021/11/244611397_1194785584320990_6265045071816304131_n-1.jpg?fit=180%2c180&#038;ssl=1", location: "Germany" },
  { name: "Polushon", description: "Experimental, jazz, world music. Sweden.", websiteUrl: "http://polushon.com/", streamUrl: "https://whsh4u-clients.com:18323/proxy/ndhfnbqx?mp=/stream", logoUrl: "https://thumbnailer.mixcloud.com/unsafe/300x300/profile/5/d/0/1/aa1b-e4e6-48e8-9128-75506e38dd92.jpg", location: "Sweden" },
  { name: "Resonance Extra", description: "Experimental, global, sound art. UK.", websiteUrl: "https://extra.resonance.fm/", streamUrl: "http://stream.resonance.fm:8000/resonance-extra", logoUrl: "https://extra.resonance.fm/favicon.ico", location: "UK" },
  { name: "Radio Wombat", description: "Experimental, punk, soul. Toscana.", websiteUrl: "https://wombat.noblogs.org/", streamUrl: "http://s.streampunk.cc/wombat.ogg", logoUrl: "", location: "Italy" },
  { name: "Radio Caprice – Experimental", description: "Avant-garde, experimental music.", websiteUrl: "http://radcap.ru/playback-history/4/experimental-ph.php", streamUrl: "http://79.111.119.111:8004/experimentalmusic", logoUrl: "http://radcap.ru/apple-touch-icon.png", location: "" },
  { name: "Radio NABA", description: "Alternative, avant-garde, experimental. Latvia.", websiteUrl: "http://www.naba.lv/", streamUrl: "http://nabamp0.latvijasradio.lv:8016/;", logoUrl: "", location: "Latvia" },
  { name: "Path through the Forest", description: "Alternative, avant-garde, experimental, psychedelic, stoner. Hamburg.", websiteUrl: "http://laut.fm/path_through_the_forest", streamUrl: "http://stream.laut.fm/path_through_the_forest", logoUrl: "", location: "Germany" },
  { name: "Skylab Radio", description: "Ambient, eclectic, experimental, hip-hop, house, rock, techno. Melbourne.", websiteUrl: "http://skylab-radio.com/", streamUrl: "http://stream.skylab-radio.com:8000/live", logoUrl: "", location: "Melbourne, Australia" },
  { name: "Super45.fm", description: "Experimental, indie. Chile.", websiteUrl: "https://super45.fm/", streamUrl: "https://s4.radio.co/s421105570/listen", logoUrl: "https://super45.fm/favicon.ico", location: "Chile" },
  { name: "Radio Caprice – Experimental Techno", description: "Experimental techno. Russia.", websiteUrl: "http://radcap.ru/exptechno.html", streamUrl: "http://213.141.131.10:8000/experimentaltechno", logoUrl: "http://radcap.ru/apple-touch-icon.png", location: "Russia" },
  { name: "Modular-Station", description: "Ambient, electronic, experimental, modular synthesis. France.", websiteUrl: "https://modular-station.com/", streamUrl: "https://broadcast.modular-station.com/radio/8000/radio.aac", logoUrl: "https://modular-station.com/app/themes/modular-station/dist/images/modular-station-192_3bcbc4e6.png", location: "France" },
  { name: "Experimentalgems", description: "Ambient, avantgarde, drone, electronic, experimental, jazz.", websiteUrl: "https://laut.fm/experimentalgems", streamUrl: "http://stream.laut.fm/experimentalgems", logoUrl: "", location: "Germany" },
  { name: "Radio Centraal 106.7", description: "Avant-garde, community, experimental, situationist. Belgium.", websiteUrl: "https://www.radiocentraal.be/", streamUrl: "http://streams.movemedia.eu:8530/", logoUrl: "https://www.radiocentraal.be/favicon.ico", location: "Belgium" },
  { name: "Radio Punctum", description: "Alternative, ambient, electronic, experimental. Prague.", websiteUrl: "https://radiopunctum.cz/", streamUrl: "https://radiopunctum.cz:8001/radio", logoUrl: "https://radiopunctum.cz/favicon/android-chrome-512x512.png", location: "Prague, Czechia" },
  { name: "radio aporee", description: "Experimental, sound art. Berlin.", websiteUrl: "https://radio.aporee.org/", streamUrl: "http://radio.aporee.org:8000/aporee", logoUrl: "https://radio.aporee.org/favicon.ico", location: "Berlin, Germany" },
  { name: "Standing Wave Radio", description: "Art, community, experimental. New York.", websiteUrl: "https://wavefarm.org/wgxc", streamUrl: "http://audio.wavefarm.org:8000/transmissionarts.mp3", logoUrl: "", location: "USA" },
  { name: "Systrum Sistum SSR1", description: "Ambient, drone, electronica, experimental. Australia.", websiteUrl: "https://www.systrum.net/", streamUrl: "https://systrum.net:8443/SSR1", logoUrl: "https://www.systrum.net/assets/img/favicons/favicon.svg", location: "Australia" },
  { name: "p-node", description: "Experimental. France.", websiteUrl: "https://p-node.org/", streamUrl: "http://stream.p-node.org/dab.mp3", logoUrl: "", location: "France" },
  { name: "Radio Gugelhopf", description: "Experimental rock, punk, ska, world. Switzerland.", websiteUrl: "http://radiogugelhopf.ch/", streamUrl: "http://uk3.internet-radio.com:8113/stream", logoUrl: "", location: "Switzerland" },
  { name: "ORF Ö1 Campus", description: "Campus, experimental, pop, world. Vienna.", websiteUrl: "https://oe1.orf.at/campus", streamUrl: "https://orf-live.ors-shoutcast.at/campus-q2a", logoUrl: "https://oe1.orf.at/static/img/logo_oe1.png", location: "Vienna, Austria" },
  { name: "Yammat FM", description: "Alternative, dance, disco, experimental, funk. Croatia.", websiteUrl: "https://www.yammat.fm/", streamUrl: "https://stream.yammat.fm/radio/8000/yammat.mp3", logoUrl: "", location: "Croatia" },
  { name: "Fango Radio", description: "Experimental. Italy.", websiteUrl: "https://www.fangoradio.com/", streamUrl: "https://pantano.ovh:8444/pantano", logoUrl: "https://www.fangoradio.com/img/fango-logo.png", location: "Italy" },
  { name: "Laut.FM Befreite-Musik", description: "Electronic, experimental, jazz, minimal. Germany.", websiteUrl: "https://www.befreitemusik.de/iradio/", streamUrl: "http://stream.laut.fm/befreite-musik", logoUrl: "https://www.befreitemusik.de/favicon.ico", location: "Germany" },
  { name: "Radio Caprice – Avant Rock", description: "Avant-garde rock, experimental rock.", websiteUrl: "http://radcap.ru/avantrock.html", streamUrl: "http://213.141.131.10:8004/avantrock", logoUrl: "http://radcap.ru/graf2/radcaplogo.png", location: "Russia" },
  { name: "syg.ma", description: "Experimental. Russia.", websiteUrl: "https://radio.syg.ma/", streamUrl: "https://radio.syg.ma/audio", logoUrl: "https://radio.syg.ma/icons/apple-icon-120x120.png", location: "Russia" },
  { name: "Witch House on WaveRadio", description: "Experimental, witch house.", websiteUrl: "https://web.archive.org/web/20170504194856/http://witch.waveradio.org/", streamUrl: "https://station.waveradio.org/witch", logoUrl: "", location: "Russia" },
  { name: "I Hate Free Speech Radio", description: "Comedy, experimental, freeform, metal, punk, satire. Cleveland.", websiteUrl: "http://ihatefreespeech.com/", streamUrl: "https://s22.myradiostream.com/15152/listen.mp3", logoUrl: "", location: "USA" },
  { name: "Tilos Rádió", description: "Alternative, community, freeform, independent. Budapest.", websiteUrl: "http://tilos.hu/", streamUrl: "http://stream.tilos.hu/tilos", logoUrl: "http://tilos.hu/favicon.ico", location: "Budapest, Hungary" },
  { name: "KBOO 90.7", description: "Freeform. Portland, Oregon.", websiteUrl: "http://www.kboo.fm/", streamUrl: "http://live.kboo.fm:8000/high", logoUrl: "http://www.kboo.fm/sites/default/files/favicons/apple-touch-icon-120x120.png", location: "Portland, USA" },
  { name: "WPRB 103.3 FM", description: "Freeform, indie, not-for-profit. Princeton, NJ.", websiteUrl: "http://wprb.com/", streamUrl: "http://wprb.streamguys1.com/live", logoUrl: "", location: "USA" },
  { name: "WXNA 101.5", description: "Community, freeform. Nashville.", websiteUrl: "http://www.wxnafm.org/", streamUrl: "http://listen.wxnafm.org:8000/stream", logoUrl: "", location: "Nashville, USA" },
  { name: "KXLU 88.9 FM", description: "College, freeform. Los Angeles.", websiteUrl: "http://kxlu.com/", streamUrl: "http://www.ednixon.com:8120/stream", logoUrl: "https://kxlu.com/wp-content/uploads/2019/02/kxlusplatblack-125x125.png", location: "Los Angeles, USA" },
  { name: "KFFP-LP Freeform Portland", description: "Community, eclectic, freeform. Oregon.", websiteUrl: "https://www.freeformportland.org/", streamUrl: "http://listen.freeformportland.org:8000/stream", logoUrl: "", location: "USA" },
  { name: "UncertainFM", description: "Alternative, freeform, indie. USA.", websiteUrl: "https://uncertain.fm/", streamUrl: "https://uncertain.fm/streams/direct", logoUrl: "https://uncertain.fm/favicon.ico", location: "USA" },
  { name: "8K.NZ", description: "Community, eclectic, freeform, indie. New Zealand.", websiteUrl: "http://8k.nz/8K/phone/index.html", streamUrl: "http://radio8k.out.airtime.pro:8000/radio8k_a", logoUrl: "", location: "New Zealand" },
  { name: "The Global Voice", description: "Freeform, oldies, talk. London.", websiteUrl: "http://theglobalvoice.info/", streamUrl: "http://theglobalvoice.info:8000/broadband", logoUrl: "", location: "London, UK" },
  { name: "KRBX Radio Boise", description: "Community, freeform. Boise, ID.", websiteUrl: "https://radioboise.us/", streamUrl: "http://radioboise-ice.streamguys1.com/live", logoUrl: "", location: "USA" },
  { name: "WCBN 88.3", description: "Freeform, university radio. Ann Arbor.", websiteUrl: "http://www.wcbn.org/", streamUrl: "http://floyd.wcbn.org:8000/wcbn-hi.mp3", logoUrl: "", location: "USA" },
  { name: "Radio Banda Larga", description: "Community, DJ, eclectic, freeform. Italy.", websiteUrl: "https://rbl.media/en", streamUrl: "https://rblmedia.out.airtime.pro/rblmedia_a", logoUrl: "https://rbl.media/favicon.ico", location: "Italy" },
  { name: "WMFO 91.5 Tufts", description: "College, freeform. Medford, MA.", websiteUrl: "http://www.wmfo.org/", streamUrl: "http://new-webstream.wmfo.org/;", logoUrl: "https://www.wmfo.org/wp-content/uploads/2016/09/wmfologo-1.png", location: "USA" },
  { name: "FunHouse Radio", description: "Classic alternative, comedy, freeform, mashup.", websiteUrl: "https://funhouseradio.com/", streamUrl: "https://ais-edge105-live365-dal02.cdnstream.com/a02627?filetype=.mp3&_=1", logoUrl: "https://funhouseradious.files.wordpress.com/2021/06/3000_purplebg.png?w=192", location: "USA" },
  { name: "KWVA 88.1", description: "Freeform, university. Eugene, Oregon.", websiteUrl: "http://kwva.uoregon.edu/", streamUrl: "http://kwvaradio.uoregon.edu:8000/;", logoUrl: "http://kwva.uoregon.edu/modules/contrib/uo_core/uo-web-design-framework/images/favicons/apple-touch-icon.png", location: "USA" },
  { name: "WUSB 90.1 Stony Brook", description: "Freeform, university. Long Island.", websiteUrl: "http://www.wusb.fm/", streamUrl: "http://stream.wusb.stonybrook.edu:8090/;.mp3", logoUrl: "", location: "USA" },
  { name: "KPCR Pirate Cat Radio", description: "Alternative, college, post retro freeform. California.", websiteUrl: "https://www.kpcr.org/pirate-cat-radio", streamUrl: "http://perseus.shoutca.st:9679/stream", logoUrl: "http://cdn-profiles.tunein.com/s51110/images/logog.png?t=159984", location: "USA" },
  { name: "Radio Free Americana", description: "Americana, freeform, garage, indie, roots. USA.", websiteUrl: "https://radiofreeamericana.com/", streamUrl: "http://janus.cdnstream.com:5140/live", logoUrl: "https://i0.wp.com/radiofreeamericana.com/wp-content/uploads/RFA-Logos/cropped-RFA-VinylRecordLogo-512x512-1.png", location: "USA" },
  { name: "WHCM 88.3 Hawk Radio", description: "College, freeform. Palatine, IL.", websiteUrl: "http://whcmfm.com/", streamUrl: "http://ice3.securenetsystems.net/WHCM", logoUrl: "", location: "USA" },
  { name: "WAYO 104.3 Rochester", description: "Community, freeform. Rochester, NY.", websiteUrl: "https://wayofm.org/", streamUrl: "http://streaming.wayofm.org:8000/wayo-192", logoUrl: "", location: "USA" },
  { name: "KPISS", description: "Brooklyn community, freeform.", websiteUrl: "https://kpiss.fm/", streamUrl: "http://streaming.live365.com/a18444", logoUrl: "https://kpiss.fm/wp-content/themes/kpiss-b-1.0.1/images/logo.png", location: "Brooklyn, USA" },
  { name: "KUZU-LP 92.9 Denton", description: "Community, freeform, independent. Texas.", websiteUrl: "http://www.kuzu.fm/", streamUrl: "http://138.197.2.189:8000/kuzu.mp3", logoUrl: "http://static1.squarespace.com/static/56d75c78356fb0d6f3fcaaf3/t/56d7a4547da24f51d8f8312f/1456972887326/GLOBE2.jpg?format=1000w", location: "USA" },
  { name: "River Theater Radio", description: "Americana, blues, community, freeform. Guerneville, CA.", websiteUrl: "https://www.rivertheaterradio.com/", streamUrl: "http://s30.myradiostream.com:31904/listen.m4a", logoUrl: "https://images.squarespace-cdn.com/content/v1/5d3385f73530e5000176743a/1581581011383-HEI1U91CUFQ990Z1ZCC9/Facebook+Header_TreeSkyRecord+copy.jpg", location: "USA" },
  { name: "WYXR", description: "Arts, culture, freeform. Tennessee.", websiteUrl: "https://wyxr.org/", streamUrl: "https://crosstown.streamguys1.com:80/live", logoUrl: "https://wyxr.org/favicon.ico", location: "USA" },
  { name: "KEOL Eastern Oregon", description: "College, freeform. Oregon.", websiteUrl: "https://www.eou.edu/keol/", streamUrl: "http://barix.streamguys.net/barix_hi", logoUrl: "https://www.eou.edu/favicon.ico", location: "USA" },
  { name: "8 Ball Radio", description: "Community, eclectic, freeform. NYC.", websiteUrl: "https://8ballradio.nyc/", streamUrl: "https://eightball.out.airtime.pro/eightball_a", logoUrl: "https://cdn.sanity.io/images/ziyj54q4/production/d0abc5b57a73a6441b862797db6723bef5d45a4c-1256x1256.jpg?h=1000&fit=max&auto=format", location: "New York, USA" },
  { name: "Mushroom Radio", description: "Freeform, student-run. The Hague.", websiteUrl: "https://radiomushroom.org/", streamUrl: "https://radio.goodtimesbadtimes.club/radio/8020/radio.mp3", logoUrl: "https://radiomushroom.org/images/logo.jpg", location: "Netherlands" },
  { name: "WMHB 89.7 FM", description: "Alternative, college, freeform. Maine.", websiteUrl: "https://wmhbradio.org/", streamUrl: "https://streaming.live365.com/a46702", logoUrl: "https://wmhbradio.org/favicon.ico", location: "USA" },
  { name: "Mad Wasp Radio", description: "Alternative, eclectic, freeform. London.", websiteUrl: "https://madwaspradio.com/", streamUrl: "https://streaming.radio.co/s8a8d7b49a/listen", logoUrl: "https://pbs.twimg.com/profile_images/1684130478981279744/QqiJhxb9_400x400.jpg", location: "UK" },
  { name: "Radio Laurier", description: "Alternative, college, freeform, indie. Canada.", websiteUrl: "https://radiolaurier.com/", streamUrl: "https://radiolaurier.out.airtime.pro/radiolaurier_a", logoUrl: "https://radiolaurier.com/wp-content/uploads/2020/06/cropped-RL-circle-logo.png", location: "Canada" },
  { name: "WXYC", description: "Freeform. Chapel Hill.", websiteUrl: "https://wxyc.org/", streamUrl: "https://audio-mp3.ibiblio.org/wxyc.mp3", logoUrl: "https://assets.mcnc.org/uploads/2020/01/casey-burns-app-icon_2x_400x400.png", location: "USA" },
  { name: "Takoma Radio WOWD", description: "Commercial-free, freeform, non-profit. Maryland.", websiteUrl: "https://takomaradio.org/", streamUrl: "https://wowd.broadcasttool.stream/stream", logoUrl: "https://images.squarespace-cdn.com/content/v1/556f2ac3e4b0ddec6e056cab/cc8a6b23-556c-4889-988a-7c6a9034fbcd/White+Halfmoon+Transparent.png?format=1500w", location: "USA" },
  { name: "WRCT", description: "Freeform. Pittsburgh.", websiteUrl: "https://www.wrct.org/", streamUrl: "http://stream.wrct.org/wrct-hi.mp3", logoUrl: "https://wrct.org/wp-content/themes/tabloid-chic/images/logo.png", location: "USA" },
  { name: "shirley & spinoza", description: "College, eclectic, experimental. Compound Eye.", websiteUrl: "http://compound-eye.org/", streamUrl: "http://s2.radio.co/sec5fa6199/listen", logoUrl: "", location: "China" },
  { name: "Drone Radio (MRG.fm)", description: "Ambient, drone, experimental. New York.", websiteUrl: "https://www.mrg.fm/", streamUrl: "http://listen.mrg.fm:8070/stream", logoUrl: "https://mrg.fm/img/droneradio125.jpg", location: "USA" },
  { name: "Radio Relativa", description: "Abstract, ambient, club, electronic, experimental. Madrid.", websiteUrl: "https://radiorelativa.eu/", streamUrl: "https://streamer.radio.co/sd6131729c/listen", logoUrl: "https://radiorelativa.eu/icon/apple-icon-120x120.png", location: "Madrid" },
  { name: "Rocket Radio 1", description: "Ambient, downtempo, electro, experimental. Bologna.", websiteUrl: "https://rocketradiolive.com/", streamUrl: "https://stream.radiojar.com/nvvyes7gud5tv", logoUrl: "https://images.squarespace-cdn.com/content/v1/53d6c3efe4b07a1cdbbae414/1520288879144-STBAF8R3I9C523AUA4LS/favicon.ico?format=100w", location: "Italy" },
  { name: "Newtown Radio", description: "Dance, disco, electronic, experimental. New York.", websiteUrl: "https://newtownradio.com/", streamUrl: "https://streaming.radio.co/s0d090ee43/listen", logoUrl: "https://newtownradio.flywheelstaging.com/wp-content/uploads/2019/07/favicon.ico", location: "USA" },
  { name: "Ad Infinitum", description: "Ambient, black metal, electronic, experimental.", websiteUrl: "https://laut.fm/ad_infinitum", streamUrl: "http://stream.laut.fm/ad_infinitum", logoUrl: "", location: "" },
  { name: "WZBT 91.1 Gettysburg", description: "College, freeform, jazz. Pennsylvania.", websiteUrl: "http://www.wzbt.org/", streamUrl: "http://war.str3am.com:8310/live", logoUrl: "https://www.wzbt.org/wp-content/uploads/2016/09/wzbt_ipad_retna.png", location: "USA" },
  { name: "WMMT", description: "Freeform. Kentucky.", websiteUrl: "https://www.wmmt.org/", streamUrl: "https://aurora.shoutca.st/radio/8200/radio.mp3?", logoUrl: "https://www.wmmt.org/apple-touch-icon.png", location: "USA" },
  { name: "WCWM", description: "College, freeform. Virginia.", websiteUrl: "https://wcwm.wm.edu/", streamUrl: "https://wcwm.broadcasttool.stream/wcwm-onair", logoUrl: "https://wcwm.wm.edu/wp-content/uploads/2023/12/wcwm_website_headerlogo-1.svg", location: "USA" },
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
          location: s.location,
          lat: s.lat,
          lng: s.lng,
        });
      }
    } else {
      flat.push({
        name: s.name,
        description: s.description,
        websiteUrl: s.websiteUrl,
        streamUrl: s.streamUrl,
        logoUrl: s.logoUrl,
        location: s.location,
        lat: s.lat,
        lng: s.lng,
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
/** View mode for stations list: grid (cards) or list (bars). */
let stationsViewMode: "grid" | "list" = "grid";

/** Admin overrides for any station (built-in or added) keyed by streamUrl. hidden = true means station is removed from the site. */
let stationOverrides: Record<string, { name?: string | null; description?: string | null; websiteUrl?: string | null; logoUrl?: string | null; location?: string | null; lat?: number | null; lng?: number | null; hidden?: boolean }> = {};

function applyStationOverride<T extends { name?: string; description?: string; websiteUrl?: string; logoUrl?: string; location?: string; lat?: number; lng?: number }>(
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
    ...(o.location !== undefined && o.location !== null && { location: o.location }),
    ...(o.lat !== undefined && o.lat !== null && { lat: o.lat }),
    ...(o.lng !== undefined && o.lng !== null && { lng: o.lng }),
  } as T;
}

function getExternalStationsFlat(): ExternalStation[] {
  const q = stationsSearchQuery.trim().toLowerCase();
  if (!q) return allExternalStations;
  return allExternalStations.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      (s.description && s.description.toLowerCase().includes(q)) ||
      (s.location && s.location.toLowerCase().includes(q))
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
      location?: string | null;
      lat?: number | null;
      lng?: number | null;
    }>;
    const overrides = (await overridesRes.json()) as Array<{ streamUrl: string; name?: string | null; description?: string | null; websiteUrl?: string | null; logoUrl?: string | null; location?: string | null; lat?: number | null; lng?: number | null; hidden?: boolean }>;
    stationOverrides = {};
    for (const o of overrides || []) {
      if (o.streamUrl) stationOverrides[o.streamUrl] = { name: o.name, description: o.description, websiteUrl: o.websiteUrl, logoUrl: o.logoUrl, location: o.location, lat: o.lat, lng: o.lng, hidden: !!o.hidden };
    }
    const userStations: ExternalStation[] = (rows || []).map((r) => ({
      id: r.id,
      name: r.name || "Station",
      description: r.description || "",
      websiteUrl: r.websiteUrl || r.streamUrl,
      streamUrl: r.streamUrl,
      logoUrl: r.logoUrl || "",
      location: r.location ?? undefined,
      lat: r.lat ?? undefined,
      lng: r.lng ?? undefined,
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
const stationsList = document.getElementById("stations-list")!;
const stationsSearchTopbar = document.getElementById("stations-search-topbar") as HTMLInputElement | null;
const favoritesFilter = document.getElementById("favorites-filter") as HTMLInputElement | null;
const favoritesFilterWrap = document.getElementById("favorites-filter-wrap");
const topbarSearchWrap = document.getElementById("topbar-search-wrap");
const topbarClockEl = document.getElementById("topbar-clock");
const topbarSearchToggle = document.getElementById("topbar-search-toggle");
const topbarSearchClose = document.getElementById("topbar-search-close");
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
const playerExpanded = document.getElementById("player-expanded")!;
const playerExpandBtn = document.getElementById("player-expand-btn")!;
const playerExpandedTitle = document.getElementById("player-expanded-title")!;
const playerExpandedLocation = document.getElementById("player-expanded-location")!;
const playerExpandedDesc = document.getElementById("player-expanded-desc")!;
const playerExpandedWebsiteLink = document.getElementById("player-expanded-website-link") as HTMLAnchorElement | null;
const playerExpandedCover = document.getElementById("player-expanded-cover") as HTMLImageElement | null;
const btnPrevExpanded = document.getElementById("btn-prev-expanded");
const btnPlayPauseExpanded = document.getElementById("btn-play-pause-expanded");
const btnNextExpanded = document.getElementById("btn-next-expanded");
const playPauseIconExpanded = document.getElementById("play-pause-icon-expanded");
const playPauseTextExpanded = document.getElementById("play-pause-text-expanded");
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

const PLAY_ICON_SVG = '<svg viewBox="0 0 12 14" fill="currentColor" stroke="none"><path d="M0 0 L12 7 L0 14 Z"/></svg>';
const PAUSE_ICON_SVG = '<svg viewBox="0 0 12 14" fill="currentColor" stroke="none"><rect x="0" y="0" width="4" height="14"/><rect x="8" y="0" width="4" height="14"/></svg>';

function setPlayPauseIcons(paused: boolean, label: string) {
  const iconSvg = paused ? PLAY_ICON_SVG : PAUSE_ICON_SVG;
  playPauseIcon.innerHTML = iconSvg;
  playPauseText.textContent = label;
  if (playPauseIconExpanded) playPauseIconExpanded.innerHTML = iconSvg;
  if (playPauseTextExpanded) playPauseTextExpanded.textContent = label;
}

function showPauseButton() {
  btnPlayPause.disabled = false;
  btnPlayPause.classList.remove("hidden");
  setPlayPauseIcons(false, "Pause");
}

function showPlayButton(label: "Start" | "Play" = "Play") {
  btnPlayPause.disabled = false;
  btnPlayPause.classList.remove("hidden");
  setPlayPauseIcons(true, label);
}

function updateFooterPlayerVisibility(): void {
  const playing = !!(currentChannel || currentExternalStation);
  footerPlayer.classList.toggle("hidden", !playing);
  document.body.classList.toggle("footer-player-hidden", !playing);
}

/** Sync expanded player panel with current station/channel and play state. */
function updateExpandedPlayerUI(): void {
  playerExpandedTitle.textContent = "Not playing";
  playerExpandedLocation.textContent = "";
  playerExpandedDesc.textContent = "";
  if (playerExpandedWebsiteLink) {
    playerExpandedWebsiteLink.href = "#";
    playerExpandedWebsiteLink.classList.add("hidden");
  }
  if (playerExpandedCover) {
    playerExpandedCover.removeAttribute("src");
    playerExpandedCover.style.display = "none";
  }
  playerExpanded.querySelector(".player-expanded-cover-wrap")?.classList.remove("placeholder");
  btnPrevExpanded?.classList.add("hidden");
  btnNextExpanded?.classList.add("hidden");

  if (currentExternalStation) {
    playerExpandedTitle.textContent = currentExternalStation.name;
    playerExpandedLocation.textContent = currentExternalStation.location ?? "";
    playerExpandedDesc.textContent = currentExternalStation.description ?? "";
    if (playerExpandedWebsiteLink) {
      playerExpandedWebsiteLink.href = currentExternalStation.websiteUrl;
      playerExpandedWebsiteLink.textContent = "Visit " + currentExternalStation.name;
      playerExpandedWebsiteLink.classList.remove("hidden");
    }
    if (playerExpandedCover && currentExternalStation.logoUrl) {
      playerExpandedCover.src = currentExternalStation.logoUrl;
      playerExpandedCover.style.display = "";
      playerExpandedCover.onerror = () => {
        if (playerExpandedCover) playerExpandedCover.style.display = "none";
      };
    } else if (playerExpandedCover) {
      playerExpanded.querySelector(".player-expanded-cover-wrap")?.classList.add("placeholder");
    }
    btnPrevExpanded?.classList.remove("hidden");
    btnNextExpanded?.classList.remove("hidden");
  } else if (currentChannel) {
    playerExpandedTitle.textContent = currentChannel.title;
    playerExpandedDesc.textContent = currentChannel.description ?? "";
    if (playerExpandedCover && currentChannel.coverUrl) {
      playerExpandedCover.src = currentChannel.coverUrl;
      playerExpandedCover.style.display = "";
    } else if (playerExpandedCover) {
      playerExpandedCover.style.display = "none";
      playerExpanded.querySelector(".player-expanded-cover-wrap")?.classList.add("placeholder");
    }
  }
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
  const chatToggle = document.getElementById("topbar-chat-toggle");
  const showAdmin = isAllowedAdmin();
  if (token && userEmail) {
    signinLink.classList.add("hidden");
    userEmailEl.textContent = userEmail;
    userEmailEl.classList.remove("hidden");
    logoutBtn.classList.remove("hidden");
    if (chatToggle) chatToggle.classList.remove("hidden");
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
    if (chatToggle) chatToggle.classList.add("hidden");
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
  const time = ts ? new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  const html = `<span class="chat-author">${escapeHtml(email)}${time ? ` <small>${time}</small>` : ""}</span> ${escapeHtml(text)}`;
  const div = document.createElement("div");
  div.className = "chat-message";
  div.innerHTML = html;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  const globalMessages = document.getElementById("chat-global-messages");
  const fullscreenMessages = document.getElementById("chat-global-fullscreen-messages");
  if (globalMessages) {
    const d = document.createElement("div");
    d.className = "chat-message";
    d.innerHTML = html;
    globalMessages.appendChild(d);
    globalMessages.scrollTop = globalMessages.scrollHeight;
  }
  if (fullscreenMessages) {
    const d = document.createElement("div");
    d.className = "chat-message";
    d.innerHTML = html;
    fullscreenMessages.appendChild(d);
    fullscreenMessages.scrollTop = fullscreenMessages.scrollHeight;
  }
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
/** Timeout after which we consider the stream failed if still "Connecting…". */
const EXTERNAL_STREAM_CONNECT_TIMEOUT_MS = 15000;
/** Timeout id for the connect timeout; cleared when onplaying or onerror fires. */
let externalStreamConnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
/** Number of reconnect attempts after stream error (e.g. upstream closes ~24s); reset on onplaying. */
let externalStreamReconnectCount = 0;
const EXTERNAL_STREAM_MAX_RECONNECTS = 10;
const EXTERNAL_STREAM_RECONNECT_DELAY_MS = 1500;
/** Wait for buffer before starting play to reduce lag/glitches. Fallback if canplaythrough doesn't fire (e.g. Safari live streams). */
const EXTERNAL_STREAM_BUFFER_WAIT_MS = 600;
const EXTERNAL_STREAM_PLAY_FALLBACK_MS = 6000;
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
  const mode = stationsViewMode;
  stationsGrid.classList.toggle("hidden", mode !== "grid");
  stationsList.classList.toggle("hidden", mode !== "list");
  stationsGrid.innerHTML = "";
  stationsList.innerHTML = "";
  const activeContainer = mode === "grid" ? stationsGrid : stationsList;

  if (streamCheckInProgress) {
    const urls = getAllStreamUrls();
    const liveCount = urls.filter((u) => streamStatusCache[u]?.ok).length;
    const total = urls.length;
    (activeContainer as HTMLElement).innerHTML = `<p class='stations-loading-message'><span class='stations-loading-text'>Looking for live radios…</span> <span class='stations-loading-count'>(${liveCount} of ${total} live so far)</span></p>`;
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
      { name: config.name, description: config.description, websiteUrl: config.websiteUrl, logoUrl: config.logoUrl, location: config.location, lat: config.lat, lng: config.lng },
      config.streamUrl
    );
    if (config.channels && config.channels.length > 0) {
      const liveChannels = config.channels.filter((ch) => {
        if (stationOverrides[ch.streamUrl]?.hidden) return false;
        const c = streamStatusCache[ch.streamUrl];
        return c && (c.ok || c.status === "verifying");
      });
      if (liveChannels.length > 0) {
        const mergedConfig = { ...config, ...configWithOverride };
        items.push({ type: "external_multi", config: mergedConfig, liveChannels });
      }
    } else {
      const c = streamStatusCache[config.streamUrl];
      if (c && (c.ok || c.status === "verifying")) {
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

  const builtInStreamUrls = new Set<string>();
  for (const item of items) {
    if (item.type === "external") builtInStreamUrls.add(item.station.streamUrl);
    if (item.type === "external_multi") for (const ch of item.liveChannels) builtInStreamUrls.add(ch.streamUrl);
  }
  const userStationsLive = allExternalStations.filter((s) => {
    if (stationOverrides[s.streamUrl]?.hidden) return false;
    if (!s.id) return false;
    if (builtInStreamUrls.has(s.streamUrl)) return false;
    const cached = streamStatusCache[s.streamUrl];
    return cached && (cached.ok || cached.status === "verifying");
  });
  const addedUserUrls = new Set<string>();
  for (const station of userStationsLive) {
    if (addedUserUrls.has(station.streamUrl)) continue;
    addedUserUrls.add(station.streamUrl);
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
    const loc =
      item.type === "laf"
        ? ""
        : item.type === "external"
          ? (item.station.location || "")
          : (item.config.location || "");
    if (q && !name.toLowerCase().includes(q) && !desc.toLowerCase().includes(q) && !loc.toLowerCase().includes(q)) return false;
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

  if (mode === "list") {
    filtered.forEach((item) => {
      const name = item.type === "laf" ? item.channel.title : item.type === "external" ? item.station.name : item.config.name;
      const loc = item.type === "laf" ? "—" : item.type === "external" ? (item.station.location || "—") : (item.config.location || "—");
      let statusText = "—";
      let statusClass = "status-unknown";
      if (item.type === "laf") {
        statusText = "LIVE";
        statusClass = "status-live";
      } else if (item.type === "external") {
        const cached = streamStatusCache[item.station.streamUrl];
        const label = getStatusLabel(cached, item.station.streamUrl);
        statusText = label.text;
        statusClass = label.statusClass;
      } else {
        const first = item.liveChannels[0];
        if (first) {
          const cached = streamStatusCache[first.streamUrl];
          const label = getStatusLabel(cached, first.streamUrl);
          statusText = label.text;
          statusClass = label.statusClass;
        }
      }
      const bar = document.createElement("button");
      bar.type = "button";
      bar.className = "station-list-bar";
      if (item.type === "laf" && currentChannel?.id === item.channel.id && ws && ws.readyState === WebSocket.OPEN) bar.classList.add("now-playing");
      if (item.type === "external" && currentExternalStation?.streamUrl === item.station.streamUrl) bar.classList.add("now-playing");
      if (item.type === "external_multi" && currentExternalStation && item.liveChannels.some((ch) => ch.streamUrl === currentExternalStation?.streamUrl)) bar.classList.add("now-playing");
      const locDisplay = loc || "—";
      bar.innerHTML = `<span class="list-bar-name">${escapeHtml(name)}</span><span class="list-bar-location">${escapeHtml(locDisplay)}</span><span class="list-bar-status ${statusClass}">${escapeHtml(statusText)}</span>`;
      bar.onclick = () => {
        if (item.type === "laf") selectChannel(item.channel);
        else if (item.type === "external") selectExternalStation(item.station);
        else {
          const ch = item.liveChannels[0];
          if (ch) selectExternalStation({ name: `${item.config.name}: ${ch.name}`, description: item.config.description, websiteUrl: item.config.websiteUrl, streamUrl: ch.streamUrl, logoUrl: item.config.logoUrl, location: item.config.location, lat: item.config.lat, lng: item.config.lng });
        }
      };
      stationsList.appendChild(bar);
    });
  }

  if (mode === "grid") filtered.forEach((item) => {
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
      const showLogoArea = hasLogo && !logoFailed;
      const logoHtml = showLogoArea
        ? `<div class="ext-station-logo-wrap"><img src="${escapeAttr(station.logoUrl)}" alt="" class="ext-station-logo" /></div>`
        : `<div class="ext-station-name-only">${escapeHtml(station.name)}</div>`;
      card.innerHTML = `
        ${logoHtml}
        ${showLogoArea ? `<div class="ext-name">${escapeHtml(station.name)}</div>` : ""}
        ${station.location ? `<div class="ext-location">${escapeHtml(station.location)}</div>` : ""}
        <div class="ext-desc">${escapeHtml(station.description)}</div>
        <a class="ext-link" href="${escapeAttr(station.websiteUrl)}" target="_blank" rel="noopener">Visit website</a>
        <div class="ext-stream-status ${statusClass}" aria-live="polite">${escapeHtml(statusText)}</div>
        ${token ? `<button type="button" class="station-card-fav ${favoriteRefs.has("external:" + station.streamUrl) ? "favorited" : ""}" data-kind="external" data-ref="${escapeAttr(station.streamUrl)}" aria-label="Favorite">${favoriteRefs.has("external:" + station.streamUrl) ? "♥" : "♡"}</button>` : ""}
      `;
      if (showLogoArea) {
        const img = card.querySelector<HTMLImageElement>(".ext-station-logo");
        if (img) {
          img.onerror = () => {
            logoLoadFailed.add(station.streamUrl);
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
      const logoFailed = hasLogo && logoLoadFailed.has(config.logoUrl);
      const showLogoArea = hasLogo && !logoFailed;
      const logoHtml = showLogoArea
        ? `<div class="ext-station-logo-wrap"><img src="${escapeAttr(config.logoUrl)}" alt="" class="ext-station-logo" /></div>`
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
        ${showLogoArea ? `<div class="ext-name">${escapeHtml(config.name)}</div>` : ""}
        ${config.location ? `<div class="ext-location">${escapeHtml(config.location)}</div>` : ""}
        <div class="ext-desc">${escapeHtml(config.description)}</div>
        <a class="ext-link" href="${escapeAttr(config.websiteUrl)}" target="_blank" rel="noopener">Visit website</a>
        <button type="button" class="ext-channels-toggle" aria-expanded="false">
          <span>${liveChannels.length} channel${liveChannels.length !== 1 ? "s" : ""}</span>
          <span class="ext-channels-chevron">▾</span>
        </button>
        <div class="ext-channels-list">${channelRows}</div>
      `;
      if (showLogoArea) {
        const img = card.querySelector<HTMLImageElement>(".ext-station-logo");
        if (img) {
          img.onerror = () => {
            logoLoadFailed.add(config.logoUrl);
            renderUnifiedStations();
          };
        }
      }
      const toggleBtn = card.querySelector<HTMLButtonElement>(".ext-channels-toggle");
      if (toggleBtn) {
        const isPlayingOneOfChannels = currentExternalStation && liveChannels.some((ch) => ch.streamUrl === currentExternalStation?.streamUrl);
        if (isPlayingOneOfChannels) {
          card.classList.add("ext-channels-open");
          toggleBtn.setAttribute("aria-expanded", "true");
        }
        toggleBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          card.classList.toggle("ext-channels-open");
          toggleBtn.setAttribute("aria-expanded", card.classList.contains("ext-channels-open") ? "true" : "false");
        });
      }
      card.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("a.ext-link") || (e.target as HTMLElement).closest(".ext-channels-toggle")) return;
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
                location: config.location,
                lat: config.lat,
                lng: config.lng,
              });
            }
          }
        }
      });
      stationsGrid.appendChild(card);
    }
  });
  if (mode === "grid") {
    const suggestCard = document.createElement("button");
    suggestCard.type = "button";
    suggestCard.className = "suggest-card";
    suggestCard.innerHTML = "<span class=\"suggest-card-title\">Are we missing any other radios you like?</span> Share with us.";
    suggestCard.onclick = () => {
      const overlay = document.getElementById("suggest-overlay");
      const urlInput = document.getElementById("suggest-url") as HTMLInputElement;
      const msgInput = document.getElementById("suggest-message") as HTMLInputElement;
      const statusEl = document.getElementById("suggest-status");
      if (overlay && urlInput) {
        urlInput.value = "";
        if (msgInput) msgInput.value = "";
        if (statusEl) { statusEl.classList.add("hidden"); statusEl.textContent = ""; }
        overlay.setAttribute("aria-hidden", "false");
        overlay.classList.add("visible");
        urlInput.focus();
      }
    };
    stationsGrid.appendChild(suggestCard);
  }
  const allUrls = getAllStreamUrls();
  const uncachedCount = allUrls.filter((u) => streamStatusCache[u] === undefined).length;
  if (filtered.length === 0) {
    if (uncachedCount > 0) {
      (activeContainer as HTMLElement).innerHTML = "<p style='opacity: 0.7;'>Checking which stations are live…</p>";
    } else {
      (activeContainer as HTMLElement).innerHTML = "<p style='opacity: 0.7;'>No stations currently live.</p>";
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
  if (cached.status === "verifying") return { text: "Checking…", statusClass: "status-unknown" };
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

/** Mark a stream as unavailable (e.g. playback failed) so it is no longer shown as LIVE. */
function markStreamUnavailable(streamUrl: string): void {
  streamStatusCache[streamUrl] = { ok: false, status: "error" };
  updateCardStatus(streamUrl, false, "error");
  renderUnifiedStations();
}

/** Verify in the browser that the stream can actually be played (same URL as user would get). Returns true if canplay/playing, false on error or timeout. */
function verifyStreamInBrowser(streamUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const playbackUrl = getExternalStreamPlaybackUrl(streamUrl);
    const audio = new Audio();
    const VERIFY_TIMEOUT_MS = 8000;
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.src = "";
      audio.oncanplay = null;
      audio.onplaying = null;
      audio.onerror = null;
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, VERIFY_TIMEOUT_MS);
    audio.oncanplay = () => {
      cleanup();
      resolve(true);
    };
    audio.onplaying = () => {
      cleanup();
      resolve(true);
    };
    audio.onerror = () => {
      cleanup();
      resolve(false);
    };
    audio.src = playbackUrl;
  });
}

/** Check a single stream (used on demand when user selects, or in full check). Skips if already cached unless force. When API says ok, we verify in browser before showing LIVE. */
function checkOneStream(streamUrl: string, force = false): Promise<void> {
  if (!force && streamStatusCache[streamUrl] !== undefined) return Promise.resolve();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STREAM_CHECK_TIMEOUT_MS);
  return fetch(`${API_URL}/api/stream-check?url=${encodeURIComponent(streamUrl)}`, { signal: controller.signal })
    .then((res) => res.json() as Promise<{ ok?: boolean; status?: string }>)
    .then((data) => {
      clearTimeout(timeoutId);
      if (data.ok) {
        streamStatusCache[streamUrl] = { ok: false, status: "verifying" };
        updateCardStatus(streamUrl, false, "verifying");
        renderUnifiedStations();
        verifyStreamInBrowser(streamUrl).then((verified) => {
          updateCardStatus(streamUrl, verified, verified ? "live" : "error");
          renderUnifiedStations();
        });
      } else {
        updateCardStatus(streamUrl, false, data.status || "error");
      }
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
      playerCoverInitial.classList.add("hidden");
      playerCoverWrap.classList.remove("placeholder");
    };
  } else {
    playerCoverWrap.classList.remove("placeholder");
    playerCover.removeAttribute("src");
    playerCoverInitial.classList.add("hidden");
  }
  externalStreamReconnectCount = 0;
  btnPrevStation.classList.remove("hidden");
  btnNextStation.classList.remove("hidden");
  updateExpandedPlayerUI();
  updateFooterPlayerVisibility();
  attachExternalStreamAudio(station);
}

/** Create Audio for current external station, attach handlers, and play. Used for initial start and for reconnect. */
function attachExternalStreamAudio(station: ExternalStation): void {
  if (externalStreamConnectTimeoutId != null) {
    clearTimeout(externalStreamConnectTimeoutId);
    externalStreamConnectTimeoutId = null;
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
  externalAudio.preload = "auto";
  externalAudio.setAttribute("playsinline", "true");
  externalStreamConnectStartTime = Date.now();
  if (externalStreamReconnectCount === 0) {
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
  }

  let playStarted = false;
  let bufferWaitTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let playFallbackTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const clearBufferWait = () => {
    if (bufferWaitTimeoutId != null) {
      clearTimeout(bufferWaitTimeoutId);
      bufferWaitTimeoutId = null;
    }
    if (playFallbackTimeoutId != null) {
      clearTimeout(playFallbackTimeoutId);
      playFallbackTimeoutId = null;
    }
  };
  const tryPlay = () => {
    if (playStarted || !externalAudio || currentExternalStation?.streamUrl !== station.streamUrl) return;
    playStarted = true;
    clearBufferWait();
    externalAudio.play().catch((err) => {
      if (externalStreamConnectTimeoutId != null) {
        clearTimeout(externalStreamConnectTimeoutId);
        externalStreamConnectTimeoutId = null;
      }
      console.error("[External stream] Play failed:", err);
      updatePlayerStatus("stopped", "Could not start stream");
      markStreamUnavailable(station.streamUrl);
    });
  };

  externalAudio.onplaying = () => {
    if (externalStreamConnectTimeoutId != null) {
      clearTimeout(externalStreamConnectTimeoutId);
      externalStreamConnectTimeoutId = null;
    }
    externalStreamReconnectCount = 0;
    updatePlayerStatus("playing", "Listening to stream");
  };
  externalAudio.onwaiting = () => {
    if (currentExternalStation?.streamUrl === station.streamUrl) {
      updatePlayerStatus("playing", "Buffering…");
    }
  };
  externalAudio.onerror = () => {
    if (externalStreamConnectTimeoutId != null) {
      clearTimeout(externalStreamConnectTimeoutId);
      externalStreamConnectTimeoutId = null;
    }
    clearBufferWait();
    const elapsed = Date.now() - externalStreamConnectStartTime;
    if (elapsed < EXTERNAL_STREAM_CONNECT_GRACE_MS) {
      updatePlayerStatus("playing", "Connecting…");
    } else {
      if (externalStreamReconnectCount < EXTERNAL_STREAM_MAX_RECONNECTS && currentExternalStation?.streamUrl === station.streamUrl) {
        externalStreamReconnectCount++;
        updatePlayerStatus("playing", "Reconnecting…");
        setTimeout(() => {
          if (!currentExternalStation || currentExternalStation.streamUrl !== station.streamUrl) return;
          attachExternalStreamAudio(station);
        }, EXTERNAL_STREAM_RECONNECT_DELAY_MS);
      } else {
        updatePlayerStatus("stopped", "Stream error");
        if (currentExternalStation?.streamUrl) markStreamUnavailable(currentExternalStation.streamUrl);
      }
    }
  };
  externalAudio.onended = () => {
    if (currentExternalStation?.streamUrl === station.streamUrl) {
      updatePlayerStatus("ready", "Stream ended");
    }
  };
  externalAudio.oncanplaythrough = () => tryPlay();
  externalAudio.oncanplay = () => {
    if (playStarted) return;
    if (bufferWaitTimeoutId != null) return;
    bufferWaitTimeoutId = setTimeout(tryPlay, EXTERNAL_STREAM_BUFFER_WAIT_MS);
  };
  playFallbackTimeoutId = setTimeout(() => {
    playFallbackTimeoutId = null;
    tryPlay();
  }, EXTERNAL_STREAM_PLAY_FALLBACK_MS);

  externalStreamConnectTimeoutId = setTimeout(() => {
    externalStreamConnectTimeoutId = null;
    clearBufferWait();
    if (currentExternalStation?.streamUrl !== station.streamUrl) return;
    updatePlayerStatus("stopped", "Could not start stream");
    markStreamUnavailable(station.streamUrl);
  }, EXTERNAL_STREAM_CONNECT_TIMEOUT_MS);
  updatePlayerStatus("playing", externalStreamReconnectCount > 0 ? "Reconnecting…" : "Connecting…");
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
  if (externalStreamConnectTimeoutId != null) {
    clearTimeout(externalStreamConnectTimeoutId);
    externalStreamConnectTimeoutId = null;
  }
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
  updateExpandedPlayerUI();
  updateFooterPlayerVisibility();
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
  updateExpandedPlayerUI();
  updateFooterPlayerVisibility();
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
  if (topbarSearchWrap) {
    topbarSearchWrap.classList.toggle("hidden", route !== "live");
    if (route !== "live") topbarSearchWrap.classList.remove("expanded");
  }
  if (route === "admin") onAdminViewShow?.();
}

const PRESET_BG_COLORS = [
  "#f5f5f5", "#111111", "#ffffff", "#000000",
  "#e74c3c", "#2ecc71", "#3498db", "#f1c40f",
  "#9b59b6", "#1abc9c", "#e67e22", "#ecf0f1",
  "#2c3e50", "#c0392b", "#27ae60", "#2980b9",
];

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.replace(/^#/, "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function getLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getContrastColors(bgHex: string): {
  text: string; textMuted: string; border: string; surface: string; cardHover: string;
  topbarBg: string; topbarText: string; accent: string; accentText: string;
} {
  const L = getLuminance(bgHex);
  const isLight = L > 0.4;
  if (isLight) {
    return {
      text: "#111",
      textMuted: "#444",
      border: "#111",
      surface: "#fff",
      cardHover: "#eee",
      topbarBg: "#111",
      topbarText: "#fff",
      accent: "#111",
      accentText: "#fff",
    };
  }
  const rgb = hexToRgb(bgHex);
  const blend = (k: number) =>
    rgb ? `rgb(${Math.round(rgb[0] * (1 - k) + 255 * k)},${Math.round(rgb[1] * (1 - k) + 255 * k)},${Math.round(rgb[2] * (1 - k) + 255 * k)})` : "#1a1a1a";
  return {
    text: "#eee",
    textMuted: "#aaa",
    border: "#eee",
    surface: blend(0.06),
    cardHover: blend(0.12),
    topbarBg: "#000",
    topbarText: "#eee",
    accent: "#eee",
    accentText: "#111",
  };
}

function applyBgColor(hex: string) {
  const root = document.documentElement.style;
  root.setProperty("--bg", hex);
  const c = getContrastColors(hex);
  root.setProperty("--text", c.text);
  root.setProperty("--text-muted", c.textMuted);
  root.setProperty("--border", c.border);
  root.setProperty("--surface", c.surface);
  root.setProperty("--card-hover", c.cardHover);
  root.setProperty("--topbar-bg", c.topbarBg);
  root.setProperty("--topbar-text", c.topbarText);
  root.setProperty("--accent", c.accent);
  root.setProperty("--accent-text", c.accentText);
  root.setProperty("--footer-bg", c.topbarBg);
  root.setProperty("--footer-text", c.topbarText);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", hex);
  document.querySelectorAll(".color-picker-preview").forEach((el) => {
    (el as HTMLElement).style.background = hex;
  });
  const customInput = document.getElementById("color-picker-custom-input") as HTMLInputElement | null;
  if (customInput) customInput.value = hex;
  const drawerCustomInput = document.getElementById("drawer-color-custom-input") as HTMLInputElement | null;
  if (drawerCustomInput) drawerCustomInput.value = hex;
}

function initColorPicker() {
  const swatchHtml = PRESET_BG_COLORS.map(
    (hex) => `<button type="button" class="color-swatch" data-color="${hex}" style="background:${hex};" aria-label="Background ${hex}" role="menuitem"></button>`
  ).join("");
  const swatchesEl = document.getElementById("color-picker-swatches");
  if (swatchesEl) swatchesEl.innerHTML = swatchHtml;
  const drawerSwatchesEl = document.getElementById("drawer-color-swatches");
  if (drawerSwatchesEl) drawerSwatchesEl.innerHTML = swatchHtml;

  const stored = localStorage.getItem("laf_bg_color");
  if (stored) {
    applyBgColor(stored);
  } else {
    applyBgColor("#f1c40f"); // default: yellow
  }

  const pickerDropdown = document.getElementById("color-picker-dropdown");
  const btn = document.getElementById("color-picker-btn");
  const btnDrawer = document.getElementById("color-picker-btn-drawer");
  const customInput = document.getElementById("color-picker-custom-input") as HTMLInputElement | null;
  const drawerCustomInput = document.getElementById("drawer-color-custom-input") as HTMLInputElement | null;

  const closePicker = () => {
    pickerDropdown?.classList.remove("open");
    btn?.setAttribute("aria-expanded", "false");
  };

  const chooseColor = (hex: string) => {
    applyBgColor(hex);
    localStorage.setItem("laf_bg_color", hex);
    closePicker();
  };

  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = pickerDropdown?.classList.toggle("open");
    btn?.setAttribute("aria-expanded", String(!!open));
  });
  btnDrawer?.addEventListener("click", (e) => {
    e.preventDefault();
    if (window.matchMedia("(min-width: 769px)").matches) {
      pickerDropdown?.classList.add("open");
      btn?.setAttribute("aria-expanded", "true");
      closeMobileNav();
    }
  });

  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (
      pickerDropdown?.classList.contains("open") &&
      !pickerDropdown.contains(t) &&
      t !== btn &&
      !btn?.contains(t) &&
      t !== btnDrawer &&
      !btnDrawer?.contains(t)
    )
      closePicker();
  });

  pickerDropdown?.querySelectorAll("[data-color]").forEach((el) => {
    el.addEventListener("click", () => {
      const hex = (el as HTMLElement).getAttribute("data-color");
      if (hex) chooseColor(hex);
    });
  });

  drawerSwatchesEl?.querySelectorAll("[data-color]").forEach((el) => {
    el.addEventListener("click", () => {
      const hex = (el as HTMLElement).getAttribute("data-color");
      if (hex) chooseColor(hex);
    });
  });

  customInput?.addEventListener("input", () => {
    const hex = customInput.value;
    if (hex) chooseColor(hex);
  });

  drawerCustomInput?.addEventListener("input", () => {
    const hex = drawerCustomInput.value;
    if (hex) chooseColor(hex);
  });
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

/** Macintosh-style topbar clock: update every second. */
function updateTopbarClock() {
  if (!topbarClockEl) return;
  const now = new Date();
  topbarClockEl.textContent = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
}
function initTopbarClock() {
  updateTopbarClock();
  setInterval(updateTopbarClock, 1000);
}

/** Search: magnifying glass toggles the search field (Mac 1984 style). */
function initSearchToggle() {
  if (!topbarSearchWrap || !topbarSearchToggle || !stationsSearchTopbar) return;
  topbarSearchToggle.addEventListener("click", () => {
    topbarSearchWrap!.classList.add("expanded");
    stationsSearchTopbar!.focus();
  });
  topbarSearchClose?.addEventListener("click", () => {
    topbarSearchWrap!.classList.remove("expanded");
    if (stationsSearchTopbar) stationsSearchTopbar.blur();
  });
  document.addEventListener("click", (e) => {
    if (!topbarSearchWrap!.classList.contains("expanded")) return;
    const target = e.target as Node;
    if (topbarSearchWrap!.contains(target)) return;
    topbarSearchWrap!.classList.remove("expanded");
  });
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

  type AdminStationRow = { id?: string; name: string; description?: string | null; streamUrl: string; websiteUrl?: string; logoUrl?: string | null; location?: string | null };
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
            location: s.location || null,
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
            <div class="form-group"><label>Location</label><input type="text" data-field="location" value="${escapeAttr(display.location || "")}" placeholder="e.g. Berlin, Germany" /></div>
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
            const locVal = (form.querySelector("[data-field=location]") as HTMLInputElement)?.value?.trim() || "";
            const webVal = (form.querySelector("[data-field=websiteUrl]") as HTMLInputElement)?.value?.trim() || "";
            const logoVal = (form.querySelector("[data-field=logoUrl]") as HTMLInputElement)?.value?.trim() || "";
            if (!nameVal) { alert("Name is required"); return; }
            (saveBtn as HTMLButtonElement).setAttribute("disabled", "true");
            try {
              if (row.id) {
                const patchRes = await fetch(`${API_URL}/api/external-stations/${row.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                  body: JSON.stringify({ name: nameVal, description: descVal || undefined, location: locVal || undefined, websiteUrl: webVal || undefined, logoUrl: logoVal || undefined }),
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
                  body: JSON.stringify({ streamUrl: row.streamUrl, name: nameVal, description: descVal || undefined, location: locVal || undefined, websiteUrl: webVal || undefined, logoUrl: logoVal || undefined }),
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

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches;
}

loadRuntimeConfig().then(() => {
  applyBroadcastLink();
  updateTopBarAuth();
  updateFooterPlayerVisibility();
  setPlayPauseIcons(true, "Start");
  initColorPicker();
  initTopbarClock();
  initSearchToggle();
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

  // View mode switcher
  document.querySelectorAll(".view-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLElement).dataset.mode as "grid" | "list";
      if (!mode) return;
      stationsViewMode = mode;
      document.querySelectorAll(".view-mode-btn").forEach((b) => {
        b.classList.toggle("active", (b as HTMLElement).dataset.mode === mode);
        b.setAttribute("aria-pressed", (b as HTMLElement).dataset.mode === mode ? "true" : "false");
      });
      renderUnifiedStations();
    });
  });

  // Expandable player
  function openExpandedPlayer() {
    const open = true;
    playerExpanded.classList.add("open");
    if (isMobileViewport()) {
      playerExpanded.classList.add("fullscreen-mobile");
      const minBar = playerExpanded.querySelector(".player-expanded-minimize");
      if (minBar) (minBar as HTMLElement).style.display = "flex";
    }
    playerExpandBtn.setAttribute("aria-expanded", "true");
    playerExpanded.setAttribute("aria-hidden", "false");
    updateExpandedPlayerUI();
  }
  function closeExpandedPlayer() {
    playerExpanded.classList.remove("open", "fullscreen-mobile");
    const minBar = playerExpanded.querySelector(".player-expanded-minimize");
    if (minBar) (minBar as HTMLElement).style.display = "none";
    playerExpandBtn.setAttribute("aria-expanded", "false");
    playerExpanded.setAttribute("aria-hidden", "true");
  }
  playerExpandBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (playerExpanded.classList.contains("open")) {
      closeExpandedPlayer();
    } else {
      openExpandedPlayer();
    }
  });
  const playerBarTapArea = document.getElementById("player-bar-tap-area");
  if (playerBarTapArea) {
    playerBarTapArea.addEventListener("click", (e) => {
      if (!isMobileViewport()) return;
      e.preventDefault();
      if (!playerExpanded.classList.contains("open")) openExpandedPlayer();
    });
  }
  const playerExpandedMinimizeBtn = document.getElementById("player-expanded-minimize-btn");
  if (playerExpandedMinimizeBtn) {
    playerExpandedMinimizeBtn.addEventListener("click", () => closeExpandedPlayer());
  }
  btnPrevExpanded?.addEventListener("click", () => btnPrevStation.click());
  btnPlayPauseExpanded?.addEventListener("click", () => btnPlayPause.click());
  btnNextExpanded?.addEventListener("click", () => btnNextStation.click());

  // Suggest overlay
  const suggestOverlay = document.getElementById("suggest-overlay");
  const suggestCancel = document.getElementById("suggest-cancel");
  const suggestSubmit = document.getElementById("suggest-submit");
  const suggestUrlInput = document.getElementById("suggest-url") as HTMLInputElement;
  const suggestMessageInput = document.getElementById("suggest-message") as HTMLInputElement;
  const suggestStatus = document.getElementById("suggest-status");
  suggestCancel?.addEventListener("click", () => {
    suggestOverlay?.classList.remove("visible");
    suggestOverlay?.setAttribute("aria-hidden", "true");
  });
  suggestOverlay?.addEventListener("click", (e) => {
    if (e.target === suggestOverlay) {
      suggestOverlay.classList.remove("visible");
      suggestOverlay.setAttribute("aria-hidden", "true");
    }
  });
  suggestSubmit?.addEventListener("click", async () => {
    const url = suggestUrlInput?.value?.trim();
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      if (suggestStatus) { suggestStatus.textContent = "Please enter a valid URL."; suggestStatus.classList.remove("hidden"); }
      return;
    }
    const message = suggestMessageInput?.value?.trim() || undefined;
    try {
      const res = await fetch(`${API_URL}/api/suggest-station`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, message }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        suggestOverlay?.classList.remove("visible");
        suggestOverlay?.setAttribute("aria-hidden", "true");
        if (suggestStatus) { suggestStatus.textContent = "Thanks! We’ll take a look."; suggestStatus.classList.remove("hidden"); suggestStatus.classList.remove("status-offline"); }
      } else {
        if (suggestStatus) { suggestStatus.textContent = data.error || "Failed to send."; suggestStatus.classList.remove("hidden"); }
      }
    } catch {
      if (suggestStatus) { suggestStatus.textContent = "Network error."; suggestStatus.classList.remove("hidden"); }
    }
  });

  // Global chat overlay (desktop) / fullscreen (mobile)
  const topbarChatToggle = document.getElementById("topbar-chat-toggle");
  const chatGlobalOverlay = document.getElementById("chat-global-overlay");
  const chatGlobalFullscreen = document.getElementById("chat-global-fullscreen");
  const chatGlobalClose = document.getElementById("chat-global-close");
  const chatGlobalFullscreenClose = document.getElementById("chat-global-fullscreen-close");
  const chatGlobalMessages = document.getElementById("chat-global-messages");
  const chatGlobalFullscreenMessages = document.getElementById("chat-global-fullscreen-messages");
  const chatGlobalSignin = document.getElementById("chat-global-signin");
  const chatGlobalFullscreenSignin = document.getElementById("chat-global-fullscreen-signin");
  const chatGlobalInputRow = document.getElementById("chat-global-input-row");
  const chatGlobalFullscreenInputRow = document.getElementById("chat-global-fullscreen-input-row");
  const chatGlobalInput = document.getElementById("chat-global-input") as HTMLInputElement;
  const chatGlobalFullscreenInput = document.getElementById("chat-global-fullscreen-input") as HTMLInputElement;
  const chatGlobalSend = document.getElementById("chat-global-send");
  const chatGlobalFullscreenSend = document.getElementById("chat-global-fullscreen-send");
  function openChat() {
    if (isMobileViewport()) {
      chatGlobalFullscreen?.classList.add("open");
      chatGlobalFullscreen?.setAttribute("aria-hidden", "false");
      if (token) {
        chatGlobalFullscreenSignin?.classList.add("hidden");
        chatGlobalFullscreenInputRow?.classList.remove("hidden");
      } else {
        chatGlobalFullscreenSignin?.classList.remove("hidden");
        chatGlobalFullscreenInputRow?.classList.add("hidden");
      }
      if (chatGlobalFullscreenMessages && chatMessages) chatGlobalFullscreenMessages.innerHTML = chatMessages.innerHTML;
    } else {
      chatGlobalOverlay?.classList.add("open");
      chatGlobalOverlay?.setAttribute("aria-hidden", "false");
      if (token) {
        chatGlobalSignin?.classList.add("hidden");
        chatGlobalInputRow?.classList.remove("hidden");
      } else {
        chatGlobalSignin?.classList.remove("hidden");
        chatGlobalInputRow?.classList.add("hidden");
      }
      if (chatGlobalMessages && chatMessages) chatGlobalMessages.innerHTML = chatMessages.innerHTML;
    }
  }
  function closeChat() {
    chatGlobalOverlay?.classList.remove("open");
    chatGlobalOverlay?.setAttribute("aria-hidden", "true");
    chatGlobalFullscreen?.classList.remove("open");
    chatGlobalFullscreen?.setAttribute("aria-hidden", "true");
  }
  topbarChatToggle?.addEventListener("click", () => openChat());
  chatGlobalClose?.addEventListener("click", () => { chatGlobalOverlay?.classList.remove("open"); chatGlobalOverlay?.setAttribute("aria-hidden", "true"); });
  chatGlobalFullscreenClose?.addEventListener("click", () => closeChat());
  function sendGlobalChat() {
    const input = isMobileViewport() ? chatGlobalFullscreenInput : chatGlobalInput;
    const text = input?.value?.trim();
    if (!text || !token) return;
    if (!currentChannel || !ws || ws.readyState !== WebSocket.OPEN) {
      if (chatGlobalMessages) {
        const el = document.createElement("div");
        el.className = "chat-message";
        el.style.opacity = "0.8";
        el.textContent = "Join a live LAF channel to participate in chat.";
        (isMobileViewport() ? chatGlobalFullscreenMessages : chatGlobalMessages)?.appendChild(el);
      }
      return;
    }
    try {
      ws.send(JSON.stringify({ type: "chat", text }));
      input!.value = "";
    } catch (err) {
      console.error("Failed to send chat:", err);
    }
  }
  chatGlobalSend?.addEventListener("click", sendGlobalChat);
  chatGlobalFullscreenSend?.addEventListener("click", sendGlobalChat);
  chatGlobalInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendGlobalChat(); } });
  chatGlobalFullscreenInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendGlobalChat(); } });
});
