export function cn(...classes: (string | false | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ");
}

export const float32ToPcm16 = (float32Array: Float32Array | number[]): Int16Array => {
  const length = (float32Array as any).length as number;
  const pcm16 = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    // @ts-ignore
    const s = Math.max(-1, Math.min(1, (float32Array as any)[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcm16;
};

// Utility function to convert base64 to Float32Array
export const base64ToFloat32Array = (base64: string): Float32Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // Convert to 16-bit PCM
  const pcm16 = new Int16Array(bytes.buffer);
  // Convert to float32
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768.0;
  }
  return float32;
};
