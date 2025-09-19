// src/index.ts
export interface Env {
  skogaiR2bucket: R2Bucket;
  OPENAI_API_KEY: string;
  ACCESS_TOKEN?: string;
}

const JSON_HDR = { "content-type": "application/json" } as const;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,x-access-token" } });
    }
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    if (env.ACCESS_TOKEN) {
      const t = req.headers.get("x-access-token");
      if (t !== env.ACCESS_TOKEN) return new Response("Forbidden", { status: 403 });
    }
    if (url.pathname === "/" && req.method === "GET") {
      return new Response("Ladda in public/index.html", { headers: { "content-type": "text/plain" } });
    }

    // --- Upload ---
    if (url.pathname === "/upload" && req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      if (!ct.startsWith("application/pdf")) return j({ ok:false,error:"Skicka application/pdf" },400);
      const ab=await req.arrayBuffer();
      const key=`uploads/${crypto.randomUUID()}.pdf`;
      await env.skogaiR2bucket.put(key,ab,{ httpMetadata:{ contentType:"application/pdf" }});
      return j({ok:true,key});
    }

    // --- Process ---
    if (url.pathname === "/process" && req.method === "POST") {
      try {
        const body=await req.json().catch(()=>({}));
        const key=body?.key as string|undefined;
        const analyses=Array.isArray(body?.analyses)?body.analyses:[];
        const options=body?.options??{};
        const model=body?.model||"gpt-4.1-mini";
        const SLICE_BYTES=Math.min(800_000,Math.max(120_000,Number(body?.slice_bytes)||300_000));
        if (!key) return j({ok:false,error:"Saknar 'key'"},400);

        const textFromClient=typeof body?.text==="string"&&body.text.trim().length>0?body.text.trim():null;

        const obj=await env.skogaiR2bucket.get(key);
        if (!obj) return j({ok:false,error:"File not found in R2",key},404);
        const ab=await obj.arrayBuffer();

        let userPayload:string; let sliceInfo=null;
        if (textFromClient){
          userPayload=`Detta är text extraherad ur ett svenskt skogsprospekt (PDF).\n\n${textFromClient}`;
        } else {
          const size=Math.min(ab.byteLength,SLICE_BYTES);
          const start=Math.max(0,ab.byteLength-size); // ta slutet av PDF
          const u8=new Uint8Array(ab).slice(start,start+size);
          sliceInfo={input_size_bytes:ab.byteLength,slice_bytes_used:u8.byteLength,partial:ab.byteLength>u8.byteLength};
          const b64=base64FromBytes(u8);
          userPayload=`Detta är en base64-slice av ett svenskt skogsprospekt (PDF). Fokusera på tabeller och sammanställningar enligt schema.\n\nPDF_base64:\n${b64}`;
        }

        const schemaStr=JSON.stringify(skogsSchema());
        const pageNote=Array.isArray(body?.pages)?`Använd i första hand siffror från sidorna: ${body.pages.join(", ")}.`:"";
        const FOCUS_HINT=`
FOKUSERA PÅ AVSNITT OCH TABELLER MED:
- "Sammanställning över fastigheten" (och 1–2 sidor efter),
- virkesförråd (m³sk), m³sk/ha, bonitet (m³sk/ha/år), tillväxt,
- huggningsklasser (S1, S2, G1, G2, K1, K2) i m³sk,
- arealfördelning (skogsmark, inägomark, impediment),
- prisidé/prisförväntan (SEK), taxeringsvärde (SEK),
- byggnader (om de finns).
IGNORERA brödtext, bilder, kartor, visningsinfo.
${pageNote}`.trim();

        const prompt=`SYSTEM:
Du är en extraktor. Returnera ENBART giltig JSON som matchar följande JSON Schema.
Sätt null där uppgift saknas. Inga förklaringar.

JSON_SCHEMA:
${schemaStr}

INSTRUKTIONER:
${FOCUS_HINT}

USER:
${userPayload}`;

        const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model,input:prompt,temperature:0,max_output_tokens:1200})});
        const openai=await r.json();

        let extractedText=openai?.output?.[0]?.content?.find((c:any)=>c.type==="output_text")?.text??openai?.output_text??null;
        let baseData=null;
        if (typeof extractedText==="string"){try{baseData=JSON.parse(extractedText);}catch{}}
        if (!baseData){const raw=JSON.stringify(openai);const inner=extractInnerJsonString(raw);if(inner){try{baseData=JSON.parse(inner);}catch{}}}

        const results:any={}; const ctx={baseData,options};
        for(const name of analyses){try{if(ANALYZERS[name]) results[name]=ANALYZERS[name](ctx); else results[name]={ok:false,error:"unknown_analyzer"}}catch(e:any){results[name]={ok:false,error:e?.message}}}

        return j({ok:true,key,model,...(sliceInfo??{input_size_bytes:ab.byteLength,slice_bytes_used:ab.byteLength,partial:false}),data:baseData,analyses:results,raw:extractedText||JSON.stringify(openai)});
      } catch(e:any){return j({ok:false,error:e?.message},500);}
    }

    if (url.pathname.startsWith("/get/")){
      const k=decodeURIComponent(url.pathname.replace("/get/",""));
      const o=await env.skogaiR2bucket.get(k);
      if (!o) return j({ok:false,error:"Not found"},404);
      return new Response(o.body,{headers:{"content-type":o.httpMetadata?.contentType||"application/pdf"}});
    }

    return j({ok:true,msg:"UI + API running"});
  }
};

// --- Helpers ---
function j(obj:any,status=200){return new Response(JSON.stringify(obj),{status,headers:{...JSON_HDR,"access-control-allow-origin":"*"}});}
function base64FromBytes(u8:Uint8Array){let s="",c=0x8000;for(let i=0;i<u8.length;i+=c) s+=String.fromCharCode.apply(null,Array.from(u8.subarray(i,i+c)) as any);return btoa(s);}
function extractInnerJsonString(s:string){const m=s.match(/{\\\"fastighet\\\"[\s\S]*?}/);return m?m[0].replace(/\\"/g,'"'):null;}
function n(v:any){if(v===null||v===undefined)return null;if(typeof v==="string"){const s=v.replace(/\s/g,"").replace(",",".");const x=Number(s);return Number.isFinite(x)?x:null;}const x=Number(v);return Number.isFinite(x)?x:null;}

function skogsSchema(){return{type:"object",properties:{
  fastighet:{type:["string","null"]},
  kommun:{type:["string","null"]},
  lage_beskrivning:{type:["string","null"]},
  areal_total_ha:{type:["number","null"]},
  skogsmark_ha:{type:["number","null"]},
  impediment_ha
