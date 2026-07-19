import { runShareModeration } from "../../../runner/pipeline.js";
import type { JsonObject, PlaytestReport, RunnerOptions } from "../../../runner/types.js";
import type { PlayContract } from "../../../packages/runtime/src/play-contract.js";
import type { RuntimeTraceReport } from "../../solve/src/runtime-trace.js";

const SHA256_IDENTIFIER = /^[a-f0-9]{64}$/i;
const RENDERED_GAME = /^data:image\/(?:gif|jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ShareModerationRequest {
  renderedGame: string;
  title: string;
  playtestReport: PlaytestReport;
  solvability: JsonObject;
  playContract: PlayContract;
  runtimeTraceReport: RuntimeTraceReport;
  safetyId: string;
}

export interface ShareModerationOptions {
  client?: RunnerOptions["client"];
  dryRun?: boolean;
  offline?: boolean;
  onRequest?: RunnerOptions["onRequest"];
}

/**
 * A mandatory gate, not a publishing function. Storage/share infrastructure
 * may act only after this returns and must retain P8/P11 evidence with the
 * immutable saved-game version it intends to publish.
 */
export async function moderateShareCandidate(
  request: ShareModerationRequest,
  options: ShareModerationOptions = {},
): Promise<JsonObject> {
  if (!SHA256_IDENTIFIER.test(request.safetyId)) {
    throw new Error("safetyId must be a 64-character privacy-preserving SHA-256 hash");
  }
  if (!RENDERED_GAME.test(request.renderedGame)) {
    throw new Error("renderedGame must be an inline GIF, JPEG, PNG, or WebP image");
  }
  if (!request.title.trim()) throw new Error("title must not be empty");
  if (request.solvability.verdict !== "ready" || !request.playtestReport.reached_goal) {
    throw new Error("share moderation requires passing P8 evidence");
  }
  if (request.playContract.outcome !== "faithful_ready") {
    throw new Error("share moderation requires a faithful runtime PlayContract");
  }
  if (
    !request.runtimeTraceReport.valid ||
    request.runtimeTraceReport.contractFormat !== request.playContract.format ||
    request.runtimeTraceReport.templateId !== request.playContract.templateId ||
    request.runtimeTraceReport.runtimeVersion !== request.playContract.runtimeVersion
  ) {
    throw new Error("share moderation requires a matching production-runtime replay receipt");
  }
  const runnerOptions: RunnerOptions = { safetyId: request.safetyId };
  if (options.client) runnerOptions.client = options.client;
  if (options.dryRun !== undefined) runnerOptions.dryRun = options.dryRun;
  if (options.offline !== undefined) runnerOptions.offline = options.offline;
  if (options.onRequest) runnerOptions.onRequest = options.onRequest;
  const verdict = await runShareModeration(
    {
      rendered_game: request.renderedGame,
      title: request.title,
      playtestReport: request.playtestReport,
      solvability: request.solvability,
    },
    runnerOptions,
  );
  if (!isRecord(verdict)) throw new Error("share moderation returned an invalid verdict");
  return verdict;
}
