declare module 'wav-decoder' {
  export interface DecodedAudio {
    sampleRate: number;
    channelData: Float32Array[];
  }
  export function decode(buffer: ArrayBuffer | Buffer): Promise<DecodedAudio>;
}
