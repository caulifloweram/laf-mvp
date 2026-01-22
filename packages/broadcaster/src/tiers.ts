export interface TierConfig {
  tier: number;
  bitrate: number; // bps
  channels: number;
}

export const TIERS: TierConfig[] = [
  { tier: 1, bitrate: 12_000, channels: 1 },
  { tier: 2, bitrate: 24_000, channels: 1 },
  { tier: 3, bitrate: 32_000, channels: 1 },
  { tier: 4, bitrate: 48_000, channels: 1 }
];

export const FRAME_DURATION_MS = 20;
export const SAMPLE_RATE = 48000;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000;
