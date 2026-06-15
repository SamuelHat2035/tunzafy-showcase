/**
 * ADK FunctionTool: search_live_jobs
 *
 * Grounds the agent in Tunzafy's REAL job corpus by calling the live public
 * endpoint `GET {TUNZAI_API_BASE}/api/jobs/semantic-search`. That endpoint is
 * backed by Vertex AI Search over ~20k active, fraud-gated jobs and re-reads
 * every hit from Postgres through the product's liveness/fraud gates before
 * returning. The agent therefore reuses the exact same grounding the product
 * uses, with no data duplication and no direct database access.
 *
 * Fail-soft: any network/parse error returns an empty, explained result instead
 * of throwing, so the agent degrades gracefully rather than crashing a turn.
 */
import { FunctionTool } from "@google/adk";
import { z } from "zod";
import { buildApiUrl } from "../config.js";

const parameters = z.object({
  query: z
    .string()
    .describe(
      "Natural-language job search, e.g. 'remote software engineer' or " +
        "'nursing jobs in Nairobi'.",
    ),
  country: z
    .string()
    .optional()
    .describe("Optional ISO country name to narrow results, e.g. 'Kenya'."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Max number of jobs to return (1-25, default 10)."),
});

interface LiveJob {
  title?: string;
  jobTitle?: string;
  company?: string;
  companyName?: string;
  location?: string;
  country?: string;
  applyUrl?: string;
  url?: string;
}

interface SemanticSearchResponse {
  enabled?: boolean;
  jobs?: LiveJob[];
  total?: number;
  summary?: string | null;
  error?: string;
}

export const jobSearchTool = new FunctionTool({
  name: "search_live_jobs",
  description:
    "Search Tunzafy's live job board for real, currently-open positions. Use " +
    "this whenever the user wants actual job listings (not general advice). " +
    "Returns real job titles, companies, locations, and apply links grounded " +
    "in Tunzafy's verified job corpus.",
  parameters,
  execute: async ({ query, country, limit }) => {
    const params = new URLSearchParams({ q: query.trim() });
    if (country?.trim()) params.set("country", country.trim());
    params.set("limit", String(limit ?? 10));

    // buildApiUrl enforces the HTTPS + host allow-list (SSRF guard).
    const url = buildApiUrl("/api/jobs/semantic-search", params);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        return {
          enabled: false,
          jobs: [],
          total: 0,
          note: `Live job search returned HTTP ${resp.status}.`,
        };
      }

      const data = (await resp.json()) as SemanticSearchResponse;
      if (data.enabled === false) {
        return {
          enabled: false,
          jobs: [],
          total: 0,
          note: "Live semantic job search is currently unavailable.",
        };
      }

      const jobs = (data.jobs ?? []).map((j) => ({
        title: j.title ?? j.jobTitle ?? "Untitled role",
        company: j.company ?? j.companyName ?? "Unknown company",
        location: j.location ?? j.country ?? "Unspecified",
        applyUrl: j.applyUrl ?? j.url ?? null,
      }));

      return {
        enabled: true,
        total: data.total ?? jobs.length,
        summary: data.summary ?? null,
        jobs,
      };
    } catch (err) {
      return {
        enabled: false,
        jobs: [],
        total: 0,
        note: `Live job search failed: ${
          (err as Error)?.message ?? String(err)
        }`,
      };
    }
  },
});
