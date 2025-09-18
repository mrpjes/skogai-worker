// src/lib/utils.ts

export const JSON_HDR = { "content-type": "application/json" } as const;

export function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HDR, "access-control-allow-origin": "*" },
  });
}

// Säkert nummer-parsning (accepterar "1 234,5")
export function n(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.replace(/\s/g, "").replace(",", ".");
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  }
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

// ByteArray -> base64 (chunkad)
export function base64FromBytes(u8: Uint8Array): string {
  let s = "";
  const c = 0x8000;
  for (let i = 0; i < u8.length; i += c) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + c)) as any);
  }
  // @ts-ignore
  return btoa(s);
}

// Plocka ut JSON som ligger strängad i OpenAI-svaret (fallback)
export function extractInnerJsonString(s: string): string | null {
  const m = s.match(/{\\\"fastighet\\\"[\s\S]*?}/);
  return m ? m[0].replace(/\\"/g, '"') : null;
}
