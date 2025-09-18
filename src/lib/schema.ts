// src/lib/schema.ts
export function skogsSchema() {
  return {
    type: "object",
    properties: {
      // --- Grunddata (direkt/härlett) ---
      fastighetsbeteckning: { type: ["string", "null"] },
      fastighet:            { type: ["string", "null"] }, // bakåtkomp: vissa prospekt använder "fastighet"
      areal_total_ha:       { type: ["number", "null"] },
      skogsmark_ha:         { type: ["number", "null"] },
      volym_total_m3sk:     { type: ["number", "null"] },
      volym_per_ha_m3sk:    { type: ["number", "null"] },
      bonitet:              { type: ["number", "null"] },
      huggningsklass:       { type: ["string", "null"] },   // t.ex. "S1, S2, G1, K1"
      tradslag_andelar: {
        type: "object",
        properties: {
          gran_procent: { type: ["number", "null"] },
          tall_procent: { type: ["number", "null"] },
          "löv_procent":{ type: ["number", "null"] },
        },
        required: ["gran_procent","tall_procent","löv_procent"]
      },
      byggnader: {
        type: ["object","null"],
        properties: {
          finns: { type: ["boolean","null"] },
          typer: { type: ["array","null"], items: { type: "string" } } // t.ex. ["bostad","ekonomibyggnad"]
        },
        additionalProperties: true
      },

      // --- Ekonomiska uppgifter från prospektet (kan vara tomma) ---
      pris_forvantning_sek: { type: ["number", "null"] },
      taxeringsvarde_sek:   { type: ["number", "null"] }
    },
    required: ["skogsmark_ha","volym_total_m3sk"],
    additionalProperties: true
  };
}
