import { n } from "../lib/utils";

export default function value_indicator({ baseData, options }: any) {
  const P = n(baseData?.pris_forvantning_sek);
  const V = n(baseData?.volym_total_m3sk);
  const A = n(baseData?.skogsmark_ha) ?? n(baseData?.areal_total_ha);
  if (!P || !V || !A) return { ok:false, reason:"saknar P/V/A" };

  const ppm3 = P / V;
  const ppha = P / A;
  const bench_ppm3 = n(options?.bench_ppm3) ?? 350;
  const bench_ppha = n(options?.bench_ppha) ?? 70000;

  const score = ((bench_ppm3 - ppm3)/bench_ppm3)*0.5 + ((bench_ppha - ppha)/bench_ppha)*0.5;
  const signal = score > 0.1 ? "billig" : score < -0.1 ? "dyr" : "neutral";
  return { ok:true, ppm3, ppha, bench_ppm3, bench_ppha, score, signal };
}
