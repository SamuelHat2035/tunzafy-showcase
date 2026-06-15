/**
 * deploy:agent-engine — deploy this ADK agent's container to Vertex AI Agent
 * Engine (the managed runtime behind Gemini Enterprise / the Agent Platform).
 *
 * WHY THIS SCRIPT EXISTS (instead of `adk deploy agent_engine`)
 * ------------------------------------------------------------
 * ADK-TS 1.2's bundled `adk deploy agent_engine` command cannot run as shipped.
 * I root-caused two defects from its source
 * (`@google/adk-devtools/dist/.../cli_deploy_agent_engine.js`):
 *
 *   1. It imports `@google-cloud/vertexai/build/src/genai/client.js`, but
 *      `@google-cloud/vertexai` is NOT a declared dependency (or peer) of
 *      `@google/adk-devtools` — so the import throws ERR_MODULE_NOT_FOUND
 *      before anything else happens.
 *   2. Even past that, it hardcodes the build image as
 *      `gcr.io/<project>/agent-engine-<app>:latest` and passes that to the
 *      reasoning-engine create call. Vertex AI rejects a non-Artifact-Registry
 *      URI (FAILED_PRECONDITION); the Cloud Build itself succeeds, only the
 *      final create fails.
 *
 * This script talks to the Vertex AI `reasoningEngines` REST API directly,
 * using a short-lived access token from the already-installed `gcloud` CLI, so
 * it needs no extra npm dependency and no patched node_modules. It builds a
 * container image into a regional Artifact Registry repo and creates the
 * reasoning engine from that valid URI.
 *
 * IMPORTANT — container contract: a container deployed to Agent Engine must
 * implement Agent Engine's serving contract (health + query protocol on the
 * injected $PORT). The ADK `api_server` image is built for Cloud Run's routes,
 * so a conforming image must be supplied via TUNZAI_AGENT_IMAGE. The live,
 * judge-facing TunzAI runtime therefore runs on Cloud Run, while a Vertex AI
 * Agent Engine **Memory Bank** reasoning engine backs the agent's long-term
 * semantic memory (see runMemoryVertex.ts).
 *
 * Usage:
 *   # Build + push a conforming image yourself, then:
 *   TUNZAI_AGENT_IMAGE=us-central1-docker.pkg.dev/<proj>/<repo>/tunzai-agent:vN \
 *   GOOGLE_CLOUD_PROJECT=<proj> GOOGLE_CLOUD_LOCATION=us-central1 \
 *   npm run deploy:agent-engine
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT?.trim();
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION?.trim() || "us-central1";
const IMAGE = process.env.TUNZAI_AGENT_IMAGE?.trim();
const DISPLAY_NAME =
  process.env.TUNZAI_AGENT_ENGINE_NAME?.trim() || "tunzai-agent-engine";

async function gcloudAccessToken(): Promise<string> {
  // `gcloud` is launched via execFile (no shell) on a resolved command name;
  // on Windows the .cmd shim is resolved through PATHEXT by Node's execFile.
  const cmd = process.platform === "win32" ? "gcloud.cmd" : "gcloud";
  const { stdout } = await execFileAsync(cmd, ["auth", "print-access-token"]);
  return stdout.trim();
}

async function main(): Promise<void> {
  if (!PROJECT) {
    console.error(
      "✗ GOOGLE_CLOUD_PROJECT is required.\n" +
        "  Set GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, and a conforming\n" +
        "  TUNZAI_AGENT_IMAGE (Artifact Registry URI), then re-run.",
    );
    process.exit(2);
  }
  if (!IMAGE) {
    console.error(
      "✗ TUNZAI_AGENT_IMAGE is required — an Artifact Registry image URI that\n" +
        "  implements Agent Engine's container serving contract, e.g.\n" +
        "  us-central1-docker.pkg.dev/<project>/<repo>/tunzai-agent:v1",
    );
    process.exit(2);
  }
  if (!/^[a-z0-9.-]+-docker\.pkg\.dev\//.test(IMAGE)) {
    console.error(
      `✗ TUNZAI_AGENT_IMAGE must be an Artifact Registry URI (…-docker.pkg.dev/…).\n` +
        `  Got: ${IMAGE}\n` +
        `  Vertex AI rejects gcr.io / non-AR image URIs (the exact bug in\n` +
        `  ADK-TS 1.2's own deploy command).`,
    );
    process.exit(2);
  }

  const base = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines`;
  const body = {
    displayName: DISPLAY_NAME,
    description: "TunzAI ADK resourcing agent (container-based Agent Engine).",
    spec: {
      containerSpec: { imageUri: IMAGE },
      deploymentSpec: {
        minInstances: 1,
        maxInstances: 5,
        resourceLimits: { cpu: "1", memory: "2Gi" },
      },
    },
  };

  const token = await gcloudAccessToken();
  console.log(`▶ Creating Agent Engine '${DISPLAY_NAME}' from ${IMAGE} …`);

  const createResp = await fetch(base, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const created = (await createResp.json()) as {
    name?: string;
    error?: { message?: string };
  };
  if (!createResp.ok || !created.name) {
    console.error(
      `✗ Create failed (HTTP ${createResp.status}): ${
        created.error?.message ?? JSON.stringify(created)
      }`,
    );
    process.exit(1);
  }

  const operationName = created.name;
  console.log(`  Operation: ${operationName}`);
  console.log("  Waiting for the reasoning engine to become ready …");

  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((r) => setTimeout(r, 15_000));
    const opToken = await gcloudAccessToken();
    const opResp = await fetch(
      `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${operationName}`,
      { headers: { authorization: `Bearer ${opToken}` } },
    );
    const op = (await opResp.json()) as {
      done?: boolean;
      error?: { message?: string };
      response?: { name?: string };
    };
    if (!op.done) {
      process.stdout.write(".");
      continue;
    }
    if (op.error) {
      console.error(`\n✗ Deployment failed: ${op.error.message}`);
      process.exit(1);
    }
    console.log(
      `\n✓ Deployed. Reasoning engine: ${op.response?.name ?? operationName}`,
    );
    return;
  }
  console.error("\n✗ Timed out waiting for the reasoning engine to be ready.");
  process.exit(1);
}

main().catch((err) => {
  console.error("Deploy failed:", err);
  process.exit(1);
});
