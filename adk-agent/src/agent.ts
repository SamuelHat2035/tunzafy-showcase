/**
 * TunzAI Resourcing Agent — built with the Google Agent Development Kit (ADK).
 *
 * This is the ADK-native re-implementation of Tunzafy's resourcing agent. It
 * demonstrates the core ADK concepts:
 *
 *   • LlmAgent            — declarative agents backed by Gemini.
 *   • FunctionTool        — typed, Zod-validated tools the model can call.
 *   • Multi-agent routing — a coordinator (root) agent that delegates to two
 *                           specialist sub-agents via ADK's built-in transfer.
 *   • Callbacks           — per-agent before/after tool hooks (see callbacks.ts)
 *                           that harden inputs and record grounding.
 *   • Memory              — PreloadMemoryTool injects relevant prior-session
 *                           context (see runMemory.ts for the full demo).
 *   • Grounding           — the job-search tool calls Tunzafy's live Vertex AI
 *                           Search-backed API, so answers are grounded in the
 *                           real ~20k-job corpus.
 *
 * Global concerns (telemetry + a least-privilege tool policy) are added as ADK
 * Plugins at the runner level — see plugins.ts, security.ts, and run.ts.
 *
 * Run locally:   npm run agent:web   (ADK dev UI)   or   npm run demo "<prompt>"
 * Deploy:        Vertex AI Agent Engine (see README).
 */
import { LlmAgent, PreloadMemoryTool } from "@google/adk";
import { afterToolGrounding, beforeToolGuard } from "./callbacks.js";
import { AGENT_MODEL } from "./config.js";
import { jobMarketDataTool } from "./tools/jobMarketData.js";
import { jobSearchTool } from "./tools/jobSearch.js";
import { resumeTemplatesTool } from "./tools/resumeTemplates.js";

/**
 * Specialist 1 — Job Search Agent.
 * Finds real openings and explains the labour market for a role/location.
 */
export const jobSearchAgent = new LlmAgent({
  name: "job_search_agent",
  model: AGENT_MODEL,
  description:
    "Finds real, currently-open jobs from Tunzafy's live board and explains " +
    "labour-market conditions (pay, demand, growth) for a role and location.",
  instruction:
    "You are TunzAI's job-search specialist. When the user wants actual job " +
    "listings, call search_live_jobs and present the real results clearly " +
    "(title, company, location, and apply link when available). When they ask " +
    "about prospects, pay, demand, or trends, call get_job_market_data first " +
    "and ground your answer in what it returns. Never invent jobs or figures " +
    "the tools did not return. Be concise, practical, and encouraging.",
  tools: [jobSearchTool, jobMarketDataTool, new PreloadMemoryTool()],
  // ADK callbacks: harden tool inputs + record grounding into session state.
  beforeToolCallback: beforeToolGuard,
  afterToolCallback: afterToolGrounding,
});

/**
 * Specialist 2 — Career Coach Agent.
 * Gives CV / application guidance grounded in the real TunzAI Pro templates,
 * and is premium-aware about automated features.
 */
export const careerCoachAgent = new LlmAgent({
  name: "career_coach_agent",
  model: AGENT_MODEL,
  description:
    "Helps with CVs/resumes and job applications using Tunzafy's real CV " +
    "template guidance. Premium-aware about automated CV building / auto-apply.",
  instruction:
    "You are TunzAI's career coach. For any CV, resume, or application help, " +
    "call find_resume_templates first so your guidance matches the five real " +
    "TunzAI Pro styles (professional, creative, technical, executive, " +
    "minimalist). You may share general guidance with anyone, but automatic " +
    "CV generation and auto-applications are TunzAI Pro (premium) features — " +
    "never imply a free user can auto-build a CV or auto-apply right now; " +
    "frame those as upgrades to TunzAI Pro. Be warm, specific, and actionable.",
  tools: [resumeTemplatesTool, new PreloadMemoryTool()],
  beforeToolCallback: beforeToolGuard,
  afterToolCallback: afterToolGrounding,
});

/**
 * Root coordinator — routes each request to the right specialist using ADK's
 * built-in LLM-driven agent transfer (sub-agents). It handles greetings itself
 * and keeps a clean separation between social conversation and job delivery.
 */
export const rootAgent = new LlmAgent({
  name: "tunzai_resourcing_agent",
  model: AGENT_MODEL,
  description:
    "TunzAI — Tunzafy's resourcing coordinator. Routes job-search vs. career/CV " +
    "requests to the right specialist and handles general conversation.",
  instruction:
    "You are TunzAI, Tunzafy's friendly resourcing agent. Decide what the user " +
    "needs and delegate:\n" +
    "• Job listings, pay, demand, or market questions → transfer to " +
    "job_search_agent.\n" +
    "• CV, resume, or application help → transfer to career_coach_agent.\n" +
    "• A plain greeting or social chit-chat → reply warmly yourself, keep it " +
    "conversational, and do NOT dump job listings or a checklist. Only move to " +
    "jobs once the user actually expresses a job intent.\n" +
    "If the user refers to something from earlier, you may recall it from " +
    "memory before answering.\n" +
    "Always be concise, encouraging, and honest; never invent data.",
  // ADK memory: automatically injects relevant prior-session context (from the
  // runner's memory service) into the prompt each turn.
  tools: [new PreloadMemoryTool()],
  subAgents: [jobSearchAgent, careerCoachAgent],
});

export default rootAgent;
