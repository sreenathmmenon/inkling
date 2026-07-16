/**
 * Inkling Pipeline Runner
 * ------------------------------------------------------------------
 * Loads spec/pipeline.json (the machine-readable version of the PDF) and
 * executes each call with the EXACT model + reasoning effort + prompt +
 * strict schema defined there. No prompt is hardcoded here — prompts live
 * in /prompts, schemas in /spec/schemas. Change the spec, not this file.
 *
 * What it does for you:
 *   - resolves dependencies (topological order)
 *   - runs `parallel_group` calls concurrently (the fan-out)
 *   - honors run_if / loop_until / effort_router / escalate_to
 *   - passes each prior result into dependents by dotted input path
 *   - attaches strict Structured Outputs + few-shot + safety_identifier
 *
 * Usage:  runPipeline({ image }, { safetyId })     // drawing scan
 *         runPipeline({ photo, annotations }, ...)  // photo mode
 */

import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const openai = new OpenAI();
const ROOT = join(__dirname, "..");
const spec = JSON.parse(readFileSync(join(ROOT, "spec/pipeline.json"), "utf8"));

type Ctx = Record<string, any>;
const load = (p: string) => readFileSync(join(ROOT, p), "utf8");
const loadJson = (p: string) => JSON.parse(load(p));

/** Resolve a dotted path like "gamespec.hero" against accumulated results. */
function resolveInputs(inputs: string[], base: Ctx, results: Ctx): Ctx {
  const out: Ctx = {};
  for (const key of inputs) {
    const clean = key.replace(/\?$/, ""); // optional marker
    if (clean in base) { out[clean] = base[clean]; continue; }
    const [head, ...rest] = clean.split(".");
    const src = results[head] ?? base[head];
    out[clean] = rest.length ? rest.reduce((o, k) => o?.[k], src) : src;
  }
  return out;
}

/** Simple predicate evaluator for run_if / loop_until (spec-controlled, not user input). */
function truthy(expr: string | undefined, ctx: Ctx): boolean {
  if (!expr) return true;
  if (expr.includes("includes")) {
    const [path, , val] = expr.split(/\s+/);
    const arr = path.split(".").reduce((o, k) => o?.[k], ctx) ?? [];
    return Array.isArray(arr) && arr.includes(val.replace(/['"]/g, ""));
  }
  const [path, op, valRaw] = expr.split(/\s*(==|!=)\s*/);
  const lhs = path.trim().split(".").reduce((o, k) => o?.[k], ctx);
  const rhs = valRaw?.replace(/['"]/g, "");
  return op === "!=" ? String(lhs) !== rhs : String(lhs) === rhs;
}

/** Execute one call per the spec. */
async function runCall(call: any, base: Ctx, results: Ctx, opts: any) {
  // conditional skip
  if (call.run_if && !truthy(call.run_if, { ...base, ...results })) return null;

  // effort router (e.g. P2 calibrates simple->low / rich->medium)
  let effort = call.effort;
  if (call.effort_router) {
    const r = results[call.effort_router.call];
    effort = call.effort_router[r?.complexity] ?? call.effort;
  }

  const model = spec.models[call.model];
  const promptText = load(call.prompt);
  const inputVars = resolveInputs(call.input ?? [], base, results);

  // build the request in the exact PDF-specified shape
  const req: any = {
    model,
    reasoning: {
      effort,
      mode: call.realtime ? spec.globals.reasoning_mode_live
                          : (opts.offline ? spec.globals.reasoning_mode_offline
                                          : spec.globals.reasoning_mode_live),
    },
    text: { verbosity: spec.globals.text_verbosity_json },
    safety_identifier: opts.safetyId,
    input: buildMessages(promptText, inputVars, call),
  };

  // strict structured output where a schema is declared
  if (call.schema) {
    req.text.format = {
      type: "json_schema",
      ...loadJson(call.schema),
      strict: true,
    };
  }
  // native codex tools
  if (call.tools) req.tools = call.tools.map((t: string) => ({ type: t }));

  // fan-out over an array field (e.g. one behavior module per entity)
  if (call.fan_out_over) {
    const arr = dotted(call.fan_out_over, { ...base, ...results }) ?? [];
    const parts = await Promise.all(
      arr.map((item: any) => callOnce({ ...req, input: buildMessages(promptText, { ...inputVars, item }, call) }, call))
    );
    return mergePatches(parts);
  }

  // loop_until (e.g. solvability repair, max_iterations)
  if (call.loop_until) {
    let last: any, i = 0;
    do {
      last = await callOnce(req, call);
      results[call.id] = last;
      i++;
    } while (!truthy(call.loop_until, { ...base, verdict: last?.verdict }) && i < (call.max_iterations ?? 3));
    return last;
  }

  // escalate on low-confidence / uncertain
  let res = await callOnce(req, call);
  if (call.escalate_to && res?.verdict === "uncertain") {
    res = await callOnce({ ...req, reasoning: { ...req.reasoning, effort: call.escalate_to } }, call);
  }
  return res;
}

async function callOnce(req: any, call: any) {
  const r = await openai.responses.create(req);
  const text = r.output_text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text, _call: call.id }; }
}

function buildMessages(system: string, vars: Ctx, call: any) {
  const msgs: any[] = [{ role: "developer", content: system }];
  if (call.fewshot) for (const ex of loadJson(call.fewshot)) msgs.push(ex); // cache-stable
  const content: any[] = [];
  if (vars.image) content.push({ type: "input_image", image_url: vars.image, detail: "high" });
  if (vars.photo) content.push({ type: "input_image", image_url: vars.photo, detail: "high" });
  const rest = Object.fromEntries(Object.entries(vars).filter(([k]) => !["image", "photo"].includes(k)));
  content.push({ type: "input_text", text: JSON.stringify(rest) });
  msgs.push({ role: "user", content });
  return msgs;
}

const dotted = (p: string, o: Ctx) => p.replace(/\[\]\..*$/, "").split(".").reduce((a, k) => a?.[k], o);
const mergePatches = (parts: any[]) => ({ patches: parts.flatMap(p => p?.patches ?? [p]) });

/** Topologically ordered execution honoring parallel_groups. */
export async function runPipeline(base: Ctx, opts: { safetyId: string; offline?: boolean }) {
  const results: Ctx = {};
  const done = new Set<string>();
  const calls: any[] = spec.calls;
  const ready = () => calls.filter(c =>
    !done.has(c.id) && (c.depends_on ?? []).every((d: string) => done.has(d)));

  while (done.size < calls.length) {
    const batch = ready();
    if (!batch.length) break; // conditional calls that never ran
    // group parallelizable siblings
    const groups: Record<string, any[]> = {};
    for (const c of batch) (groups[c.parallel_group ?? c.id] ??= []).push(c);

    for (const g of Object.values(groups)) {
      const settled = await Promise.all(g.map(async c => {
        const out = await runCall(c, base, results, opts);
        // gate: block the whole pipeline if a gate says so
        if (c.blocks_pipeline_on && out &&
            String(out[Object.keys(c.blocks_pipeline_on)[0]]) ===
            Object.values(c.blocks_pipeline_on)[0]) {
          throw new PipelineBlocked(c.id, out);
        }
        return [c.id, out] as const;
      }));
      for (const [id, out] of settled) { results[id] = out; done.add(id); }
    }
  }
  return results;
}

class PipelineBlocked extends Error {
  constructor(public callId: string, public verdict: any) {
    super(`blocked at ${callId}`);
  }
}
