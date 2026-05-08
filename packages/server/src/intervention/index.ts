/**
 * Intervention protocol — file-based mailbox for human-in-the-loop.
 *
 * When the supervisor escalates to human:
 * 1. Write .orca/intervention.json with the question/context
 * 2. Send notification
 * 3. Pause the task
 * 4. Poll .orca/intervention_response.json for the answer
 * 5. On response: resume, remove both files
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

export interface InterventionRequest {
  timestamp: string;
  taskId: string;
  cause: string;
  diagnosis: string;
  evidence?: string;
  suggestedFix?: string;
  supervisorReasoning?: string;
}

export type InterventionAction = "continue" | "skip" | "abort";

export interface InterventionResponse {
  action: InterventionAction;
  note?: string;
}

const REQUEST_FILE = "intervention.json";
const RESPONSE_FILE = "intervention_response.json";

export async function writeIntervention(
  orcaDir: string,
  request: InterventionRequest,
): Promise<void> {
  if (!existsSync(orcaDir)) {
    mkdirSync(orcaDir, { recursive: true });
  }
  writeFileSync(
    join(orcaDir, REQUEST_FILE),
    JSON.stringify(request, null, 2),
  );
}

export async function pollForResponse(
  orcaDir: string,
  pollIntervalMs = 10000,
): Promise<InterventionResponse> {
  const responsePath = join(orcaDir, RESPONSE_FILE);

  return new Promise((resolve) => {
    const check = () => {
      if (existsSync(responsePath)) {
        try {
          const raw = readFileSync(responsePath, "utf8");
          const response = JSON.parse(raw) as InterventionResponse;
          resolve(response);
          return;
        } catch {
          // File exists but isn't valid JSON yet — keep polling
        }
      }
      setTimeout(check, pollIntervalMs);
    };
    check();
  });
}

export async function clearIntervention(orcaDir: string): Promise<void> {
  const requestPath = join(orcaDir, REQUEST_FILE);
  const responsePath = join(orcaDir, RESPONSE_FILE);
  try { unlinkSync(requestPath); } catch {}
  try { unlinkSync(responsePath); } catch {}
}
