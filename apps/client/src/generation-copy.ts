const GENERIC_FAILURE = "We could not finish this game right now. The drawing was not posted or shared. Please try again.";

const FAILURE_BY_CODE: Readonly<Record<string, string>> = {
  drawing_not_approved: "Let’s try a drawing without a real face, name, or personal details.",
  game_not_finishable: "This version was not ready to play. Try a clearer photo or a new drawing.",
  generation_busy: "Lots of games are being made right now. Your photo is still ready—please try again in a moment.",
  generation_rate_limited: "You have made several games quickly. Wait a little, then try again with this photo.",
  request_too_large: "That photo is too large to send. Choose a smaller photo and try again.",
};

const CUSTOMER_SAFE_FAILURES = new Set([GENERIC_FAILURE, ...Object.values(FAILURE_BY_CODE)]);

/** Converts server error codes into calm, child-facing recovery copy. */
export function generationErrorMessage(code?: string): string {
  return code ? FAILURE_BY_CODE[code] ?? GENERIC_FAILURE : GENERIC_FAILURE;
}

/** Never lets a browser, transport, provider, or model error leak into the UI. */
export function visibleGenerationFailure(error: unknown): string {
  if (error instanceof Error && CUSTOMER_SAFE_FAILURES.has(error.message)) return error.message;
  return GENERIC_FAILURE;
}
