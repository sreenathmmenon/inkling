/**
 * Single source of truth for the upload size contract. The handbook-declared
 * product limit is one prepared drawing of at most 8 MiB; every other cap is
 * derived from it here so the stacked boundaries can never drift apart:
 *
 * - the capture client refuses larger source files with child-facing copy,
 * - the drawing service refuses larger decoded images as invalid requests,
 * - the HTTP servers refuse request bodies that could not possibly carry a
 *   legal upload, before any generation work is admitted.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Base64 expansion of the largest legal image inside its JSON data URL. */
const BASE64_IMAGE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/**
 * Bounded JSON envelope around the encoded image: field names, request id,
 * up to six echoed 240-character corrections, and the compact non-artwork
 * parts of a rescanned prior document. (The prior document's own artwork is
 * a prepared ≤1600px crop, far below the image cap.)
 */
const REQUEST_ENVELOPE_BYTES = 1024 * 1024;

/** Hard HTTP body cap for a generation upload, derived — never hand-tuned. */
export const MAX_REQUEST_BYTES = BASE64_IMAGE_BYTES + REQUEST_ENVELOPE_BYTES;
