// src/lib/schema.ts
export function skogsSchema() {
  return {
    type: "object",
    properties: {
      // --- Grunddata (från prospektet/härlett) ---
      fastighetsbeteckning: { type: ["string","null"] },
      fastighet:            { type: ["string","null"] }, // bakåtkompatibelt
      kommun:               { type: ["string","null"] },
      lage_beskrivning:     { type: ["string","null"] },

      areal_total_ha:   { type: ["number","null"] },
      skogsmark_ha:     { type: ["number","null"] },

      volym_total_m3sk:  { type: ["number","null"] },
      volym_per_ha_m3sk: { type: ["number","null"] },

      bonitet:       { type: ["number","null"] }, // m³sk/ha/år

      // Huggningsklasser med volym per klass (viktigt för S1+S2)
      huggningsklasser: {
        type: ["object","null"],
        properties: {
          S1_m3sk: { type: ["number","null"] },
          S2_m3sk: { type: ["number","null"] },
          G1_m3sk: { type: ["number","null"] },
          G2_m3sk: { type: ["number","null"] },
          K1_m3sk: { type: ["number","null"] },
          K2_m3sk: { type: ["number","null"] }
        },
        additionalProperties: true
      },

      tradslag_andelar: {
        type: ["object","null"],
        properties: {
          gran_procent: { type: ["number","null"] },
          tall_procent: { type: ["number","null"] },
          "löv_procent":{ type: ["number","null"] }
        },
        additionalProperties: true
      },

      byggnader: {
        type: ["object","null"],
        properties: {
          finns: { type: ["boolean","null"] },
          typer: { type: ["array","null"], items: { type: "string" } }
        },
        additionalProperties: true
      },

      // Ekonomiska uppgifter som hör hemma i Nyckeltal (presenteras där)
      pris_forvantning_sek: { type: ["number","null"] },
      taxeringsvarde_sek:   { type: ["number","null"] }
    },
    required: ["skogsmark_ha","volym_total_m3sk"],
    additionalProperties: true
  };
}
