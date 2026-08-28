# Agent tests

**The rule: an agent does not land without its test workflow.** Every agent added to BRAVO
ships with a folder under `tests/agents/<kind>/` that runs it against **at least five
different inputs**. No agent merges without one.

This is not coverage theatre. §8 requires that *"every LLM promise needs a code gate — a
deterministic check, a retry, a visible report."* An agent is one long LLM promise. These
tests are that gate, run on purpose instead of in production.

## Layout

```
tests/
  lib/                     shared: the runner, the gates, the report writer
  agents/
    router/     cases.js   ≥5 messages → the kind each must latch
    shot/       cases.js   ≥5 instructions → the tool calls each must produce
    edit/       cases.js   ≥5 instructions → Seedance 2.5 editing tasks
    storyboard/ cases.js   ≥5 briefs
    bible/      cases.js   ≥5 plate requests
```

Docs live in `docs/` — that is why there is no README inside `tests/`.

## Two layers, run differently

**1 · Gates (no model).** Pure functions over recorded output: the tool-call parser, kind
validation, citation-range checks, the no-parameters-in-prompt-text rule. Fast,
deterministic, run on every change. `node --test` — Node 24 ships it, so no test framework
is added as a dependency.

**2 · Agent runs (real reasoner).** Each case goes through the actual loop against
`/api/seed`. Non-deterministic by nature, so **assertions are structural, never
wording**: did it emit a parseable call, choose a legal tool, stay inside the ref count,
refuse an unbound slot. The prompts it produced are written to a report so a human can
judge quality — the part a machine cannot check.

## Money

**Gated tools are stubbed by default.** Five cases × `shoot` is minutes of wall clock and
real spend on every run; that would make the suite something people skip. The stub records
the request that *would* have gone out, which is the more useful artifact anyway — it is
how the edit tests assert that ratio and duration were never sent.

Opt in explicitly:

```bash
npm run test:agents              # gates + agent runs, nothing rendered
npm run test:agents -- --spend   # actually calls still/shoot/edit
```

A run that spends prints what it spent. A run that does not must assert that no gated tool
was reached — a test that silently starts costing money is a bug.

## What each agent's cases must cover

Five is the floor, and they are not five variations of the happy path. Every agent's set
includes:

- **the ordinary case** — the thing it is for;
- **a boundary** — the longest, the most refs, the cap;
- **an ambiguity** — where the honest answer is to ask, not to guess;
- **a case that must be refused** — an unbound slot, an unknown id, an out-of-range
  citation. §8: an unknown id resolves to nothing, never a default;
- **a regression** — every bug found in the field becomes a sixth case, permanently.

## The gates, per agent

| Agent | Deterministic assertions |
|---|---|
| `router` | Latches to a kind in the known list; an unrecognisable message **asks** rather than defaulting; a latched thread never re-routes |
| `shot` | Emits parseable calls; only tools from its §4 row; an unknown shot id resolves to nothing |
| `compose` | Citation numbers ≤ `refs.length`; dialogue lines preserved verbatim; **no duration, ratio or resolution in the prompt text** (§8); refuses outright when the slot has no bound skill |
| `edit` | Ratio and duration **absent** from the outgoing request (`InvalidParameter.TaskTypeConstraint`); resolution present and honoured; operates on a real `takeId` |
| `bible` | Photoreal plates ride as `image_asset_id`, never a raw url; `citedBy` updates; staleness propagates |

## Reports

Each run writes `tests/reports/<agent>-<timestamp>.md`: the input, the tool calls, the
final prompt, and pass/fail per gate. §8 asks for a *visible* report, and prompt quality is
a judgement only a person can make — the report is what they read.
