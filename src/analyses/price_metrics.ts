import { n } from "../lib/utils";

export default function price_metrics({ baseData }: any) {
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
}
