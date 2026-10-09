import { env } from "cloudflare:workers";
import skillText from "../../../../skills/cloud-therapist/SKILL.md?raw";
import methodText from "../../../../skills/cloud-therapist/references/consultation-method.md?raw";
import { THERAPIST_OUTPUT_SCHEMA } from "../../../../packages/therapist/output.mjs";

export const CLOUD_THERAPIST_SKILL_VERSION = "cloud-therapist@2026-10-08.1";

export function therapistRunConfig() {
  if (!env.THERAPIST_MODEL || !env.OPENAI_API_KEY) return null;
  return {
    model: env.THERAPIST_MODEL,
    skill_version: CLOUD_THERAPIST_SKILL_VERSION,
    instructions: `${skillText.trim()}\n\n${methodText.trim()}`,
    output_schema: THERAPIST_OUTPUT_SCHEMA,
    max_tool_calls: 12,
  };
}
