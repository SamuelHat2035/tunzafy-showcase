/**
 * ADK discovery entry point.
 *
 * The ADK CLI (`adk web`, `adk deploy agent_engine`, `adk run`) discovers agents
 * as `<agents_dir>/<agentName>/agent.{ts,js}` exporting `rootAgent`. This folder
 * is that entry point; all real logic lives in `../src` and is re-exported here
 * so the agent name surfaced to ADK / Agent Engine is `tunzai_resourcing_agent`.
 */
export { rootAgent } from "../src/agent.js";
export { default } from "../src/agent.js";
