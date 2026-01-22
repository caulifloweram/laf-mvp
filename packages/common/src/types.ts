export const LAF_MAGIC = 0x4c414631; // "LAF1"
export const LAF_VERSION = 1;

export interface LAFPacket {
  magic: number;       // 0x4C414631
  version: number;     // 1
  tier: number;        // 1..N
  flags: number;       // u16
  streamId: number;    // u32
  seq: number;         // u32
  ptsMs: bigint;       // u64
  opusPayload: Buffer; // length in header
}
