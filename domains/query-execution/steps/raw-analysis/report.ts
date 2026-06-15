/** Raw-analysis final report step（结论透传 + workflow 渲染图表）。 */

import { StepOutcome } from "../../scheduler/scheduler.js";
import { renderCharts } from "../report-charts.js";
import { renderNarrative } from "../report-narrative.js";

export async function run(ctx: Record<string, any>): Promise<StepOutcome> {
  const [charts, narrative] = await Promise.all([renderCharts(ctx), renderNarrative(ctx)]);
  return StepOutcome.done({
    report: {
      summary: narrative?.summary ?? null,
      highlights: narrative?.highlights ?? [],
      caveats: narrative?.caveats ?? null,
      execution_result: ctx["execution_result"] ?? {},
    },
    charts,
  });
}
