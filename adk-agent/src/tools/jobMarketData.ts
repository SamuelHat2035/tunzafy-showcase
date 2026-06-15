/**
 * ADK FunctionTool: get_job_market_data
 *
 * Returns a labour-market snapshot (open roles, salary band, demand, growth, top
 * skills) for a role in a location. The headline `open_roles_estimate` is now
 * GROUNDED in Tunzafy's live corpus: it calls the same public
 * `/api/jobs/semantic-search` endpoint and reports the real `total` match count.
 * The qualitative band (salary/growth/skills) remains a deterministic heuristic,
 * clearly labelled, so the tool runs out of the box and is honest about which
 * fields are live vs. illustrative.
 */
import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { buildApiUrl } from "../config.js";

const parameters = z.object({
  location: z
    .string()
    .describe("City, region, or country, e.g. 'Nairobi' or 'Kenya'."),
  role: z
    .string()
    .describe("Job title or role, e.g. 'data analyst' or 'nurse'."),
});

const DEMAND_LEVELS = ["low", "moderate", "high", "very high"] as const;
const TOP_SKILLS = [
  "communication",
  "problem solving",
  "Excel",
  "SQL",
  "stakeholder management",
];

/** Best-effort live count of currently-open matching roles (fail-soft → null). */
async function fetchLiveOpenRoles(
  role: string,
  location: string,
): Promise<number | null> {
  try {
    const params = new URLSearchParams({ q: `${role} ${location}`.trim() });
    params.set("country", location);
    params.set("limit", "25");
    const url = buildApiUrl("/api/jobs/semantic-search", params);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      enabled?: boolean;
      total?: number;
      jobs?: unknown[];
    };
    if (data.enabled === false) return null;
    if (typeof data.total === "number") return data.total;
    if (Array.isArray(data.jobs)) return data.jobs.length;
    return null;
  } catch {
    return null;
  }
}

export const jobMarketDataTool = new FunctionTool({
  name: "get_job_market_data",
  description:
    "Look up current labour-market data (live open-role count, median salary " +
    "band, demand level, year-over-year growth, and top requested skills) for " +
    "a specific job role in a specific location. Call this whenever the user " +
    "asks about job prospects, pay, demand, or hiring trends for a role.",
  parameters,
  execute: async ({ location, role }) => {
    const locationNorm = location.trim();
    const roleNorm = role.trim();

    // Deterministic pseudo-data derived from the inputs so identical questions
    // give identical qualitative answers (illustrative band only).
    const seed =
      [...`${locationNorm}${roleNorm}`.toLowerCase()].reduce(
        (acc, ch) => acc + ch.charCodeAt(0),
        0,
      ) || 1;
    const skills = [0, 1, 2].map((i) => TOP_SKILLS[(seed + i) % TOP_SKILLS.length]);

    // Real, live grounding for the headline number.
    const liveOpenRoles = await fetchLiveOpenRoles(roleNorm, locationNorm);

    return {
      location: locationNorm,
      role: roleNorm,
      open_roles_live: liveOpenRoles,
      open_roles_estimate: liveOpenRoles ?? 50 + (seed % 950),
      open_roles_source: liveOpenRoles !== null ? "tunzafy_live_corpus" : "estimate",
      median_annual_salary_usd: 12000 + (seed % 60) * 1000,
      year_over_year_growth_pct:
        Math.round((((seed % 25) - 5) + (seed % 10) / 10) * 10) / 10,
      demand_level: DEMAND_LEVELS[seed % DEMAND_LEVELS.length],
      top_requested_skills: skills,
      data_note:
        "open_roles_live is a real count from Tunzafy's live corpus; salary/" +
        "growth/skills are deterministic illustrative bands.",
    };
  },
});
