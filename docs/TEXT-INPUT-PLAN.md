# Text Input Plan — natural-language editing and creation

Two features, one mechanism:

1. **Edit an existing model** — "הוסף חור בקוטר 5 במרכז", "הגדל את הטקסט ל-12 מ״מ",
   "עגל את הפינות ב-3 מ״מ", "תעשה את הבסיס דק יותר".
2. **Create a new model** — "מחזיק מפתחות עם השם דני, רוחב 60 מ״מ, חור לטבעת",
   "קופסה 80×50×30 עם מכסה".

Both are the same pipeline: Hebrew free text → a validated list of **commands**
against the existing `DesignDocument` model → preview → one undoable apply.

This document is the plan, including the decisions taken and their rationale.
No code has been written for it yet.

---

## 0. Ground rules carried over from the codebase

These are not new; they are what `docs/AI-IMAGE-PLAN.md` §0 already established
and what the code enforces today.

- **Reuse over rebuild.** The document model (`types/design.ts`), the validator
  (`lib/geometry/documentValidation.ts`), the expression evaluator
  (`lib/geometry/expression.ts`), the generator specs
  (`lib/geometry/generators/specs.ts`), the modifier list
  (`lib/geometry/modifiers.ts`), the op plumbing (`hooks/useEditorOps.ts`) and
  the undo history (`lib/history/history.ts`) are the integration points. The
  text feature must not grow a second way to change a document.
- **Every external byte is hostile.** Model output is untrusted data, exactly
  like a design file or a provider mesh. It is parsed, schema-checked and
  range-clamped before it touches a document. Nothing is `eval`'d — the same
  reason `expression.ts` hand-rolls a parser instead of calling `new Function`.
- **Local-first by default; anything leaving the device is opt-in, in Hebrew,
  naming the recipient.** The text feature always leaves the device (it calls
  an LLM), so it is off until a key is configured, exactly like the cloud
  image→3D mode, and the consent notice names the provider.
- **All failure states are Hebrew and name the failing stage.**
- **Backward compatibility.** No design-file schema change: the commands
  produce ordinary layers/modifiers/parameters that older code already reads.

---

## 1. The central decision: a command DSL, not generated geometry or code

The model emits a **closed, typed list of editing commands**. It never emits
geometry, mesh data, a whole document, or code.

Three architectures were considered:

| | Approach | Verdict |
| --- | --- | --- |
| A | LLM returns a full `DesignDocument` JSON | **Rejected.** Layer ids and `meshId` references would have to survive a round trip through a language model; a single hallucinated id silently destroys an imported mesh. Every edit re-serializes the whole document (10–100× the tokens). Undo becomes "replace everything", so the history label is meaningless. Contours (`StoredContour[]`) are thousands of numbers the model has no business rewriting. |
| B | LLM returns a list of **commands** against the current document | **Chosen.** Small output (tens of tokens per command), a hallucinated id fails validation instead of corrupting data, the whole batch lands as one `document/apply` with a Hebrew label, and the command list is exactly what the preview panel renders. Testable without a network. |
| C | LLM only sets values of named `parameters[]` | **Rejected as the whole feature** — it cannot create a layer or run an operation. It survives as one command (`setParameter`) inside B. |

The consequence worth stating explicitly: **the LLM is a parser, not an
engine.** All geometry, all validation, all Hebrew UI text and all printability
advice stay in TypeScript. If the model is swapped, deleted, or unreachable,
everything downstream of the parse still works.

### 1.1 Hebrew is required on the input side only

Every user-facing string — the preview diff, the errors, the history label — is
generated locally in TypeScript from the command list, not by the model. So the
model needs Hebrew **comprehension** and accurate JSON; it never has to *write*
good Hebrew. That materially widens the set of usable (cheap) models and
removes a whole class of quality risk. It is a design constraint, not an
accident: no model-authored string is ever shown to the user.

---

## 2. Module map (proposed)

```
lib/nlp/
  commands.ts        the command union + per-command JSON schema (single source)
  schema.ts          schema → JSON-Schema for the provider; kept in sync by test
  validate.ts        pure: unknown JSON → Command[] | NlpError (ranges, ids, enums)
  apply.ts           pure: (DesignDocument, Command[]) → DesignDocument + warnings
  describe.ts        pure: Command[] → Hebrew preview lines ("יתווסף חור Ø5 במרכז")
  digest.ts          pure: DesignDocument → compact context object for the model
  fastPath.ts        deterministic Hebrew grammar for the common phrasings
  client.ts          browser client for /api/text-to-design (mirrors cloudClient.ts)
  errors.ts          NlpError taxonomy → Hebrew messages
  testMode.ts        deterministic fake provider, localStorage-gated (e2e boundary)
  providers/
    types.ts         TextCommandProvider interface + ProviderError (as lib/ai/providers)
    gemini.ts        Google AI Studio / Vertex, responseSchema JSON mode
    openaiCompat.ts  DeepSeek / Groq / OpenRouter / Ollama / any base URL
    anthropic.ts     optional high-accuracy tier (tool use, strict schema)
    index.ts         provider selection from env

app/api/text-to-design/route.ts   GET availability / POST prompt+digest → commands
lib/server/textToDesign.ts        env, rate limit, size caps, one repair retry

components/dialogs/TextCommandDialog.tsx   prompt box + preview diff + אישור/ביטול
hooks/useTextCommands.ts                   flow state machine (idle/thinking/preview)
scripts/evalNlp.mjs                        offline model/cost/accuracy harness
```

`Editor.tsx` stays composition, as it did for the cloud import: it wires
`useTextCommands` and passes two props into the dialog block.

---

## 3. The command set

Phase 1 covers the asks that actually recur, not the whole editor surface.
Every command maps 1:1 onto something the editor already does.

**Create** — `createText`, `createPrimitive`, `createHole`, `createSketchShape`
(rectangle/circle/polygon only), `runGenerator` (the six kinds already in
`GENERATOR_SPECS`, parameters validated by `numberParam`/`choiceParam`),
`applyTemplate` (the ids in `documentTemplates.ts`).

**Modify** — `setLayerProps` (a whitelist per layer type, each field range-checked
against `PARAM_RANGES` / the generator spec), `transformLayer`
(translate/rotate/scale, absolute or relative), `setCombineMode`,
`setBevel`, `setMaterialSlot`, `renameLayer`, `setVisible`, `deleteLayer`,
`duplicateLayer`.

**Operate** — `addModifier` (the existing `Modifier` union: fillet, shell, twist,
taper, bend, stretch, lattice, remesh, simplify, smooth), `boolean`
(union/difference/intersection), `pattern`, `hollow`.

**Parametric** — `defineParameter`, `setParameter`, `bindField` (writes
`bindings[field]`; the expression string is safe by construction because
`evaluateExpression` is a real parser, so the model may emit `wall * 2`).

**Document** — `setBaseMode`, `addMaterialSlot`, `setPrinterProfile`.

Deliberately **out** of phase 1: anything that needs a 3D pick (face selection,
paint, place-on-surface, drain hole), mesh import, and free-form sketch beziers.
Those have no unambiguous textual referent.

Hard limits: ≤ 25 commands per request, ≤ 500 characters of user prompt,
every numeric field clamped to the same ranges the UI clamps to, unknown
command name or unknown layer id → the whole batch is rejected with a Hebrew
error naming the offending command index. **Partial application is never
allowed** — a batch is all-or-nothing so that undo stays meaningful.

---

## 4. Context: what the model is shown

Not the document. A **digest**:

```jsonc
{
  "baseMode": "withBase",
  "units": "mm",
  "selection": ["layer_x"],
  "materialSlots": [{ "id": "slot1", "name": "צבע ראשי" }],
  "parameters": [{ "name": "wall", "value": 2 }],
  "layers": [
    { "id": "layer_a", "type": "base", "name": "בסיס",
      "size": { "w": 80, "h": 50, "t": 3 } },
    { "id": "layer_b", "type": "text", "name": "שם", "parent": null,
      "content": "דני", "sizeMm": 10, "extrudeMm": 1, "combine": "raised",
      "at": { "x": 0, "y": 0, "z": 3 }, "bbox": [40, 12, 1] }
  ]
}
```

Rules: no `contours`, no `meshId` payloads, no `facePaint`, no `anchors`.
Layer names are user text and therefore a **prompt-injection surface** — they
are passed inside a delimited data block, and the command validator (not the
prompt) is the real boundary. Digest is capped (~120 layers / ~8 KB); above
that only the selection plus the ancestor chain is sent.

Typical request: system prompt + command schema ≈ 3K tokens (identical every
call → cacheable), digest ≈ 0.3–1K, user prompt ≈ 30, output ≈ 200–400.

---

## 5. Pipeline

```
Hebrew text
  → fastPath.ts            (regex grammar; hit = zero cost, zero latency)
  → /api/text-to-design    (server holds the key; rate-limited; size-capped)
  → provider               (structured output / tool call, JSON schema enforced)
  → validate.ts            (unknown JSON → Command[]; one repair retry on failure)
  → describe.ts            (Hebrew preview lines)
  → user confirms          ← the trust gate
  → apply.ts + documentValidation.ts
  → applyDocument(next, "עריכה מטקסט")   one undo step
  → existing build/analysis pipeline unchanged
```

Two properties worth calling out:

- **The preview is not optional.** Structured output guarantees shape, never
  intent. The diff panel ("גובה הטקסט ישתנה מ-8 ל-12 מ״מ · יתווסף חור Ø5")
  is what makes a wrong parse a non-event rather than a lost design.
- **One repair round-trip, then fail.** If the model returns JSON that fails
  `validate.ts`, it is re-asked once with the validation error appended. A
  second failure is a Hebrew error, not a third call — this bounds worst-case
  cost per user action at 2 requests.

---

## 6. Provider layer and model economics

The interface mirrors `lib/ai/providers/types.ts`, which already proved the
pattern for the mesh providers:

```ts
export interface TextCommandProvider {
  readonly id: string;
  readonly nameHe: string;       // named in the consent notice
  complete(input: {
    systemPrompt: string;
    schema: JsonSchema;
    digest: unknown;
    userText: string;
    repairHint?: string;
  }): Promise<{ raw: unknown; usage: { inTokens: number; outTokens: number } }>;
}
```

`openaiCompat.ts` covers DeepSeek, Groq, OpenRouter, Together, and a local
Ollama in one file, because they all speak the same chat-completions shape with
`response_format`. That is the single most valuable line of the design: **the
model choice becomes an environment variable, not an architecture.**

### 6.1 Cost, measured against one realistic request

Assumption per user action: **4K input tokens** (3K cached schema + digest +
prompt) and **400 output tokens**. Prices are per million tokens, August 2026.

| Option | In / Out ($/M) | Per request | Per 1,000 requests | Hebrew | Notes |
| --- | --- | --- | --- | --- | --- |
| **Gemini 3.x Flash-Lite (free tier)** | 0 / 0 | **$0** | **$0** | good | Rate-limited; free-tier prompts may be used to improve Google's products — dev/hobby only, not for customer name plates |
| **Gemini 3.1 Flash-Lite (paid)** | 0.25 / 1.50 | ~$0.0016 | **~$1.6** | good | Native `responseSchema` JSON mode; **recommended default** |
| **DeepSeek V4 Flash** | 0.14 / 0.28 | ~$0.0007 | **~$0.7** | fair | Cheapest credible option; cache-hit input is $0.0028/M (≈ free); OpenAI-compatible; 5M free tokens on signup |
| **GPT-5.4-nano** | 0.20 / 1.25 | ~$0.0013 | ~$1.3 | good | Strictest structured-output implementation |
| **Groq (Llama 3.3 70B)** | 0.59 / 0.79 | ~$0.0027 | ~$2.7 | fair | Fastest (sub-second); generous free tier (30 RPM / 14.4K req-day) |
| **Groq (Llama 3.1 8B)** | 0.05 / 0.08 | ~$0.0003 | ~$0.3 | **weak** | Cheapest, but small models are the weakest at Hebrew — expect misparses |
| **Claude Haiku 4.5** | 1.00 / 5.00 | ~$0.006 | ~$6 | strong | |
| **Claude Sonnet 5** | 3.00 / 15.00 | ~$0.018 | ~$18 | strongest | Reserve for a "דיוק מרבי" toggle / hard prompts |
| **Local (Ollama, Qwen/Llama class)** | — | $0 | $0 | weak–fair | No network, no consent notice needed; needs a capable machine; keep as the offline escape hatch |

Reading of the table: at this token size the difference between the cheapest
credible option and the most expensive is **$0.7 vs $18 per 1,000 edits** —
real, but both are small against the value of one saved design. The decision
should therefore be driven by **Hebrew parse accuracy**, not by price, and the
right way to settle it is §8 (measure), not argument.

**Recommendation:** default to **Gemini Flash-Lite** (free tier while
developing, ~₪6 per 1,000 edits in production), ship `openaiCompat` so a
deployment can point at **DeepSeek** (cheapest) or a **local Ollama** (free,
offline) with an env change, and keep **Claude Sonnet** behind an optional
high-accuracy switch for long or ambiguous prompts.

### 6.2 Cost levers, in order of payoff

1. **The deterministic fast path** (`fastPath.ts`). A regex grammar over the
   recurring Hebrew phrasings — "הגדל ב-20%", "סובב 90 מעלות", "שנה טקסט ל…",
   "עובי 3 מ״מ", "מחק את …" — costs nothing and answers instantly. Expected to
   absorb a large share of real usage. Built in phase 3 *from the eval-set
   histogram*, not from guesses.
2. **Prompt caching.** The schema + system prompt is byte-identical on every
   call and dominates the input. Gemini context caching / DeepSeek cache hits
   ($0.0028/M) / Anthropic `cache_control` reduce input cost by ~10–20×.
   Requires the digest to come *after* the schema in the prompt — free if
   designed in from the start, expensive to retrofit.
3. **Digest discipline.** Never send contours or meshes (already decided).
4. **Cap retries at one** (already decided).
5. **Per-session quota + a visible counter**, so a runaway loop cannot bill.

---

## 7. Safety and trust boundaries

| Threat | Control |
| --- | --- |
| Model emits an unknown/destructive command | Closed union; unknown name → whole batch rejected |
| Model invents a layer id | Ids checked against the live document before apply |
| Out-of-range dimensions | Clamped to `PARAM_RANGES` / generator specs; `documentValidation` still runs after apply |
| Prompt injection via layer names / imported design files | Names are data in a delimited block; the validator, not the prompt, is the boundary; commands cannot exfiltrate (no network command exists) |
| Expression injection (`bindField`) | `evaluateExpression` is a real parser with no `eval`; arbitrary strings are already safe |
| API key exposure | Key is server-only (`app/api/text-to-design/*`), no `NEXT_PUBLIC_` prefix, exactly like `IMAGE_TO_3D_API_KEY` |
| Cost abuse | Per-IP rate limit + prompt size cap + one-retry cap + per-session quota |
| Privacy | Feature off until configured; Hebrew consent notice naming the provider before the first call; free tiers flagged as "not for customer data" |
| Silent wrong edit | Mandatory preview + one-step undo |

---

## 8. Evaluation harness (`scripts/evalNlp.mjs`)

A golden set of **~80 Hebrew prompts** paired with expected command lists,
drawn from the real vocabulary of the app (שלט שם, מחזיק מפתחות, מדליה, חותמת,
מארז, גלגל שיניים…). The script runs the set against any configured provider
and reports **exact-match rate, semantic-match rate, invalid-JSON rate, mean
tokens, mean latency and cost per 1,000 requests**.

This is what turns §6 from an opinion into a measurement, it is the regression
net for prompt changes, and it doubles as the input for designing the fast-path
grammar. It should exist before the second provider is written.

---

## 9. Milestones

**M0 — the engine, with no LLM at all.** `commands.ts`, `validate.ts`,
`apply.ts`, `describe.ts`, `digest.ts`, the preview dialog, and unit tests
driven by hand-written command lists. At the end of M0 the entire feature works
except that a human types the JSON. This de-risks everything and is the bulk of
the code.

**M1 — one provider, end to end.** Server proxy, availability gating, Gemini
provider, consent notice, error taxonomy, `testMode` fake for e2e. Editing an
existing model ships here.

**M2 — creation.** Blank/template seeding, `runGenerator` and `applyTemplate`
commands, clarification handling ("איזה גודל?"), multi-step prompts.

**M3 — cost and robustness.** Eval harness, fast path, prompt caching,
`openaiCompat` provider (DeepSeek/Groq/Ollama), quotas.

**M4 — optional.** "הסבר לי" mode: Hebrew printability advice generated from
the existing `lib/geometry/analysis` output rather than from the model's
opinion.

---

## 10. Decisions still needed from the product owner

1. **Provider and tier for production** — the recommendation is paid Gemini
   Flash-Lite; the free tier is fine for development but its data-usage terms
   are not appropriate for engraved customer names.
2. **Who holds the key** — one server key for all users (simple, we pay), or a
   per-user key entered in settings (no cost to us, more friction). The
   architecture supports both; the UI differs.
3. **Whether creation may run without confirmation** — editing must always be
   previewed; creating into an empty document is arguably safe to apply
   directly.
4. **Offline story** — is a local-Ollama path a requirement (workshop machines
   without internet) or a nice-to-have?
