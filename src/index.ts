export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // (valfritt) kräva hemlig header
    if (env.ACCESS_TOKEN) {
      const t = req.headers.get("x-access-token");
      if (t !== env.ACCESS_TOKEN) return new Response("Forbidden", { status: 403 });
    }

    // UI
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(HTML_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // Ladda upp PDF till R2 (kropp = rå PDF, content-type: application/pdf)
    if (url.pathname === "/upload" && req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      if (!ct.startsWith("application/pdf")) return json({ ok:false, error:"Skicka application/pdf" }, 400);
      const ab = await req.arrayBuffer();
      const key = `uploads/${crypto.randomUUID()}.pdf`;
      await env.skogaiR2bucket.put(key, ab, { httpMetadata: { contentType: "application/pdf" }});
      return json({ ok:true, key });
    }

    // Process (extrahera + analysera)
    if (url.pathname === "/process" && req.method === "POST") {
      try {
        const body = await req.json();
        const key = body?.key;
        const analyses = Array.isArray(body?.analyses) ? body.analyses : [];
        const options  = body?.options || {};
        const model    = body?.model || "gpt-4.1-mini";
        const SLICE_BYTES = Math.min(800_000, Math.max(120_000, body?.slice_bytes || 300_000));
        if (!key) return json({ ok:false, error:"Saknar 'key'" }, 400);

        const textFromClient = (body?.text && typeof body.text === "string" && body.text.trim().length>0)
          ? body.text.trim() : null;

        const obj = await env.skogaiR2bucket.get(key);
        if (!obj) return json({ ok:false, error:"File not found in R2", key }, 404);
        const ab  = await obj.arrayBuffer();

        // userPayload = klientens text eller binär slice
        let userPayload, sliceInfo = null;
        if (textFromClient) {
          userPayload = `Detta är text extraherad ur ett svenskt skogsprospekt (PDF).\n\n${textFromClient}`;
        } else {
          const u8  = new Uint8Array(ab).slice(0, Math.min(ab.byteLength, SLICE_BYTES));
          sliceInfo = { input_size_bytes: ab.byteLength, slice_bytes_used: u8.byteLength, partial: ab.byteLength > u8.byteLength };
          const b64 = base64FromBytes(u8);
          userPayload = `Detta är en base64-slice av ett skogsprospekt (PDF). Extrahera enligt schema.\n\nPDF_base64:\n${b64}`;
        }

        const schemaStr = JSON.stringify(skogsSchema());
        const prompt =
`SYSTEM:
Du är en extraktor. Returnera ENBART giltig JSON som matchar följande JSON Schema.
Sätt null där uppgift saknas. Inga förklaringar, inga markdown-block, inga extra fält.

JSON_SCHEMA:
${schemaStr}

USER:
${userPayload}`;

        // OpenAI Responses API
        const r = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            input: prompt,
            temperature: 0,
            max_output_tokens: 1200
          })
        });

        const openai = await r.json();

        // ===== Robust parsning av JSON från OpenAI =====
        let extractedText =
          openai?.output?.[0]?.content?.find(c => c.type === "output_text")?.text
          ?? openai?.output_text
          ?? null;

        let baseData = null;
        if (typeof extractedText === "string") {
          try { baseData = JSON.parse(extractedText); } catch {/* fallback nedan */}
        }

        if (!baseData) {
          const raw = JSON.stringify(openai);
          const inner = extractInnerJsonString(raw);
          if (inner) {
            try { baseData = JSON.parse(inner); } catch {}
          }
        }

        // ===== Analyser =====
        const results = {};
        const ctx = { baseData, options };
        for (const name of analyses) {
          try {
            if (ANALYZERS[name]) results[name] = ANALYZERS[name](ctx);
            else results[name] = { ok:false, error:"unknown_analyzer" };
          } catch (e) {
            results[name] = { ok:false, error: e.message };
          }
        }

        return json({
          ok: true,
          key,
          model,
          ...(sliceInfo ?? { input_size_bytes: ab.byteLength, slice_bytes_used: ab.byteLength, partial: false }),
          data: baseData,          // ← extraherad grunddata
          analyses: results,       // ← valfria analyser
          raw: extractedText || JSON.stringify(openai) // ← för felsökning
        });
      } catch (e) {
        return json({ ok:false, error:e.message }, 500);
      }
    }

    // Hämta PDF från R2 (valfritt)
    if (url.pathname.startsWith("/get/")) {
      const k = decodeURIComponent(url.pathname.replace("/get/",""));
      const o = await env.skogaiR2bucket.get(k);
      if (!o) return json({ ok:false, error:"Not found" }, 404);
      return new Response(o.body, { headers: { "content-type": o.httpMetadata?.contentType || "application/pdf" }});
    }

    return json({ ok:true, msg:"UI + API running" });
  }
};

/* ======================== HTML UI ======================== */
const HTML_PAGE = /*html*/`<!doctype html>
<html lang="sv"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SkogAI – PDF → Grunddata + Analyser</title>
<style>
body{font:16px/1.45 -apple-system,system-ui,Segoe UI,Roboto,Arial,sans-serif;max-width:900px;margin:24px}
h1{margin:0 0 12px} fieldset{border:1px solid #ddd;padding:12px 16px;margin:16px 0}
label{margin-right:14px;display:inline-flex;align-items:center;gap:6px}
input[type=number]{width:130px} button{padding:10px 14px;border-radius:8px;border:1px solid #bbb;cursor:pointer}
#out{white-space:pre-wrap;background:#fbfbfb;border:1px solid #eee;padding:12px;border-radius:8px}
.small{color:#666;font-size:13px}
.bar{height:10px;background:#eee;border-radius:8px;overflow:hidden}
.bar>div{height:100%;width:0%}
#upBar{background:#4caf50} #exBar{background:#2196f3}
code{background:#f5f5f5;padding:2px 6px;border-radius:6px}
</style>

<!-- PDF.js legacy (stabil i iOS Safari) -->
<script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.10.111/legacy/build/pdf.min.js"></script>
<script>
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.10.111/legacy/build/pdf.worker.min.js";
</script>
</head>
<body>
<h1>SkogAI – PDF → Grunddata + Analyser</h1>

<fieldset><legend>1) Ladda upp PDF</legend>
<input type="file" id="pdf" accept="application/pdf">
<button id="btnUpload">Ladda upp</button>
<div>Nyckel: <code id="key"></code></div>
<div class="small">Tips: Om fälten blir null – öka sidantal i extraheringen eller slice (fallback).</div>

<div style="margin:12px 0">
  <div>Uppladdning: <span id="upPct">0%</span></div>
  <div class="bar"><div id="upBar"></div></div>
</div>

<div style="margin:12px 0">
  <div>Extrahering (PDF.js): <span id="exPct">0%</span></div>
  <div class="bar"><div id="exBar"></div></div>
</div>
</fieldset>

<fieldset><legend>2) Välj analyser</legend>
<label><input type="checkbox" class="an" value="price_metrics" checked> Pris-metrik</label>
<label><input type="checkbox" class="an" value="risk" checked> Risk</label>
<div style="margin-top:8px">
Slice-bytes (fallback 120k–800k): <input type="number" id="slice" min="120000" max="800000" step="10000" value="300000">
Modell: <select id="model"><option value="gpt-4.1-mini" selected>gpt-4.1-mini</option></select>
</div>
<button id="btnProcess">Kör extraktion + analyser</button>
</fieldset>

<h3>Resultat</h3>
<pre id="out">{ tips: "1) Ladda upp, 2) Kör extraktion. PDF-text tas lokalt (PDF.js), annars binär slice." }</pre>

<script>
function out(o){document.getElementById('out').textContent=typeof o==='string'?o:JSON.stringify(o,null,2)}
function setUploadProgress(p){document.getElementById('upPct').textContent=Math.round(p)+'%';document.getElementById('upBar').style.width=p+'%'}
function setExtractProgress(p){document.getElementById('exPct').textContent=Math.round(p)+'%';document.getElementById('exBar').style.width=p+'%'}

function uploadToWorkerWithProgress(file){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'upload', true);
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadProgress((e.loaded/e.total)*100);
      else setUploadProgress(50);
    };
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText || '{}');
        if (xhr.status>=200 && xhr.status<300 && json.ok) resolve(json);
        else reject(json);
      } catch(e){ reject(e); }
    };
    xhr.onerror = () => reject(new Error('Nätverksfel vid upload'));
    xhr.send(file);
  });
}

async function extractTextWithPDFJS(arrayBuf, maxPages){
  const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
  const N = Math.min(pdf.numPages, maxPages);
  let text = "";
  for (let p = 1; p <= N; p++) {
    const page = await pdf.getPage(p);
    const tc   = await page.getTextContent();
    const pageText = tc.items.map(it => it.str).join(" ").replace(/\\s+/g," ").trim();
    if (pageText) text += "\\n\\n[SID "+p+"]\\n" + pageText;
    setExtractProgress((p/N)*100);
    await new Promise(r=>setTimeout(r,0));
  }
  return { text: text.trim(), pagesUsed:N, totalPages: pdf.numPages };
}

async function upload(){
  const f=document.getElementById('pdf').files[0];
  if(!f){ alert('Välj PDF'); return; }

  setUploadProgress(0); setExtractProgress(0);
  out('Laddar upp till R2 ...');

  let upJson;
  try {
    upJson = await uploadToWorkerWithProgress(f);
  } catch(e){
    out({ok:false, steg:'upload', error:String(e)});
    return;
  }
  document.getElementById('key').textContent = upJson.key;

  // Lokal extrahering (PDF.js) med timeout
  try {
    out('Extraherar text lokalt (PDF.js) ...');
    const arrayBuf = await f.arrayBuffer();
    const { text, pagesUsed, totalPages } = await Promise.race([
      extractTextWithPDFJS(arrayBuf, 20),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('PDF.js timeout')),15000))
    ]);
    window.__EXTRACTED_TEXT__ = text || "";
    out({ steg:"upload+extract", key: upJson.key, extracted_chars:(text||"").length, pages_used: pagesUsed, total_pages: totalPages });
  } catch (e) {
    console.warn('PDF.js misslyckades:', e);
    window.__EXTRACTED_TEXT__ = "";
    setExtractProgress(100);
    out({ steg:"upload (ingen lokal text, använder slice-fallback)", key: upJson.key, pdfjs_error: String(e) });
  }
}

async function processRun(){
  const key=document.getElementById('key').textContent.trim(); if(!key) return alert('Ladda upp först');
  const analyses=[...document.querySelectorAll('.an:checked')].map(x=>x.value);
  const slice=Number(document.getElementById('slice').value)||300000;
  const model=document.getElementById('model').value;
  const text = (window.__EXTRACTED_TEXT__ && window.__EXTRACTED_TEXT__.trim().length>0)
    ? window.__EXTRACTED_TEXT__ : null;

  out('Kör extraktion ...');
  const r=await fetch('process',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key, analyses, slice_bytes:slice, model, text })
  });
  out(await r.json());
}

document.getElementById('btnUpload').addEventListener('click',upload);
document.getElementById('btnProcess').addEventListener('click',processRun);
</script>
</body></html>`;
/* ======================== Hjälpare ======================== */
function json(obj, status=200){ return new Response(JSON.stringify(obj), { status, headers:{ "content-type": "application/json" }});}
function base64FromBytes(u8){ let s="",c=0x8000; for(let i=0;i<u8.length;i+=c) s+=String.fromCharCode.apply(null,u8.subarray(i,i+c)); return btoa(s); }
function extractInnerJsonString(s){
  // Fångar JSON som ligger som sträng i Responses-objektet (\"{...}\")
  const m = s.match(/{\\\"fastighet\\\"[\\s\\S]*?}/);
  return m ? m[0].replace(/\\"/g, '"') : null;
}
function n(v){
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.replace(/\\s/g, "").replace(",", ".");
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  }
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
/* ======================== JSON-schema ======================== */
function skogsSchema(){
  return {
    type: "object",
    properties: {
      fastighet:{type:["string","null"]},
      kommun:{type:["string","null"]},
      lage_beskrivning:{type:["string","null"]},
      areal_total_ha:{type:["number","null"]},
      skogsmark_ha:{type:["number","null"]},
      impediment_ha:{type:["number","null"]},
      volym_total_m3sk:{type:["number","null"]},
      volym_per_ha_m3sk:{type:["number","null"]},
      medelalder_ar:{type:["number","null"]},
      bonitet:{type:["number","null"]},
      huggningsklass:{type:["string","null"]},
      tradslag_andelar:{
        type:"object",
        properties:{
          gran_procent:{type:["number","null"]},
          tall_procent:{type:["number","null"]},
          "löv_procent":{type:["number","null"]}
        },
        required:["gran_procent","tall_procent","löv_procent"]
      },
      pris_forvantning_sek:{type:["number","null"]},
      koordinater:{type:["string","null"]}
    },
    required:["fastighet","kommun","skogsmark_ha","volym_total_m3sk"],
    additionalProperties:true
  };
}
/* ======================== Analyser ======================== */
const ANALYZERS = {
  price_metrics: ({ baseData }) => {
    const A = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
    const V = n(baseData?.volym_total_m3sk);
    const P = n(baseData?.pris_forvantning_sek);
    const vPerHa = (V && A) ? V / A : null;
    return {
      ok:true,
      areal_anv:A, volym_total_m3sk:V, volym_per_ha_m3sk:vPerHa,
      pris_forvantning_sek:P,
      pris_per_ha:(P&&A)?P/A:null,
      pris_per_m3sk:(P&&V)?P/V:null
    };
  },
  risk: ({ baseData, options }) => {
    const vPerHa = n(baseData?.volym_per_ha_m3sk)
      ?? ((n(baseData?.volym_total_m3sk) && n(baseData?.skogsmark_ha))
          ? n(baseData?.volym_total_m3sk)/n(baseData?.skogsmark_ha) : null);
    const löv = n(baseData?.tradslag_andelar?.["löv_procent"]);
    let score=0;
    if (vPerHa!==null && vPerHa < (options?.low_v_per_ha ?? 70)) score++;
    if (löv!==null && löv > (options?.high_löv_pct ?? 30)) score++;
    const level=["låg","medel","hög"][Math.min(score,2)];
    return { ok:true, score, level, vPerHa, "löv_procent": löv };
  }
};
