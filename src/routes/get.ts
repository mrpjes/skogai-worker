import type { Env } from "../index";
import { json } from "../lib/utils";

export async function handleGet(req: Request, env: Env) {
  const url = new URL(req.url);
  const k = decodeURIComponent(url.pathname.replace("/get/",""));
  const o = await env.skogaiR2bucket.get(k);
  if (!o) return json({ ok:false, error:"Not found" }, 404);
  return new Response(o.body, { headers: { "content-type": o.httpMetadata?.contentType || "application/pdf" }});
}
