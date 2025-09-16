export function skogsSchema() {
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
