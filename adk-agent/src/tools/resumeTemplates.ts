/**
 * ADK FunctionTool: find_resume_templates
 *
 * Returns Tunzafy's canonical CV/resume template guidance — the five real
 * styles that power the TunzAI Pro CV builder (kept in sync with
 * `CV_TEMPLATE_INSTRUCTIONS` in the api-server's aiJobMatcher.ts). These are
 * code constants, not a document corpus, so the agent's advice matches exactly
 * what the product actually generates.
 *
 * PREMIUM NOTE: automatic CV building and auto-applications are TunzAI Pro
 * (premium) features. This tool returns guidance the agent can share with any
 * user, but the agent is instructed (see careerCoachAgent) to frame the
 * automated builder/apply features as Pro upgrades for non-premium users.
 */
import { FunctionTool } from "@google/adk";
import { z } from "zod";

export const CV_TEMPLATES = {
  professional:
    "Use a clean, corporate structure with formal tone. Emphasize achievements with quantifiable metrics. Use bullet points for experience items.",
  creative:
    "Use a modern, engaging tone. Include a personal brand statement. Highlight soft skills alongside technical skills. Use active, dynamic language.",
  technical:
    "Focus heavily on technical competencies, tools, and certifications. Include a dedicated 'Technical Stack' section. Use precise, technical language.",
  executive:
    "Use an authoritative, strategic tone. Lead with an Executive Summary. Emphasize leadership impact, P&L responsibility, and organizational transformation.",
  minimalist:
    "Use a concise, distraction-free format. One page maximum. Short bullet points. Focus only on the most impactful achievements and relevant skills.",
} as const;

type CVStyle = keyof typeof CV_TEMPLATES;
const STYLE_NAMES = Object.keys(CV_TEMPLATES) as CVStyle[];

const parameters = z.object({
  role: z.string().describe("Target job title the resume is for."),
  style: z
    .enum(STYLE_NAMES as [CVStyle, ...CVStyle[]])
    .optional()
    .describe(
      "Optional CV style: professional | creative | technical | executive | minimalist.",
    ),
});

export const resumeTemplatesTool = new FunctionTool({
  name: "find_resume_templates",
  description:
    "Return Tunzafy's canonical TunzAI Pro resume/CV template guidance — the " +
    "five real CV styles the product uses: professional, creative, technical, " +
    "executive, and minimalist. Call this before giving CV or application " +
    "advice so guidance matches what the platform actually generates. Pass a " +
    "style to get that one template's guidance, or omit it to get all five.",
  parameters,
  execute: ({ role, style }) => {
    const matched = style && STYLE_NAMES.includes(style) ? style : null;
    const guidance = matched
      ? `${matched}: ${CV_TEMPLATES[matched]}`
      : STYLE_NAMES.map((t) => `${t}: ${CV_TEMPLATES[t]}`).join("\n");

    return {
      query: role.trim(),
      template: matched,
      guidance,
      availableTemplates: STYLE_NAMES,
      premium_note:
        "Automatic CV generation and auto-apply are TunzAI Pro (premium) " +
        "features. General guidance can be shared with anyone.",
    };
  },
});
