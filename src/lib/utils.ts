export function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export function base64FromBytes(u8: Uint8Array) {
  let s = "", c = 0x8000;
  for (let i = 0; i < u8.length; i += c) s += String.fromCharCode.apply(null, u8.subarray(i, i + c) as any);
  // @ts-ignore
  return btoa(s);
}

/** Drar ut din JSON från Responses-svaret (tittar först på output_text/content, fallback till inbäddad sträng). */
export function extractOpenAIJson(openai: any) {
  let txt: string | null =
    openai?.output?.[0]?.content?.find((c: any) => c.type === "output_text")?.text
    ?? openai?.output_text
    ?? null;

  if (typeof txt === "string") {
    try { return JSON.parse(txt); } catch {}
  }
  const raw = JSON.stringify(openai);
  const inner = extractInnerJsonString(raw);
  if (inner) {
    try { return JSON.parse(inner); } catch {}
  }
  return null;
}

function extractInnerJsonString(s: string) {
  const m = s.match(/{\\\"fastighet\\\"[\s\S]*?}/);
  return m ? m[0].replace(/\\"/g, '"') : null;
}

export function n(v: any) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.replace(/\s/g, "").replace(",", ".");
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  }
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
