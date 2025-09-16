import { n } from "../lib/utils";

export default function risk({ baseData, options }: any) {
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
