import { json } from "../lib/utils";
import type { Env } from "../index";

export async function handleUpload(req: Request, env: Env) {
  const ct = req.headers.get("content-type") || "";
  if (!ct.startsWith("application/pdf")) return json({ ok:false, error:"Skicka application/pdf" }, 400);

  const ab = await req.arrayBuffer();
  const key = `uploads/${crypto.randomUUID()}.pdf`;
  await env.skogaiR2bucket.put(key, ab, { httpMetadata: { contentType: "application/pdf" }});
  return json({ ok:true, key });
}
