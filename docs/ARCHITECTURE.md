# Architecture

How BRAVO is put together, and — more usefully — where the boundaries are. If you are
about to add an agent, a tool or a guard, this is the file that tells you which one file
to touch.

## Conventions

**No comments in code.** Not headers, not section banners, not explanations. Names and
structure carry the meaning; anything that needs prose goes in this file. The only
exception is a tooling directive such as `eslint-disable`. Add a comment when asked to,
and not otherwise.

## The shape

```
pages/index.js        the shell: state, the run registry, screens
components/           rail, thread pane, messages, results
agents/               the harness (below)
state/                the data model, persistence, concurrent merge
utils/film/           the transport kit — talks to ModelArk. Not ours; unchanged.
skills/               prompt specs, one folder each
```

## The harness

Five files with one responsibility each, and five agent modules that know nothing about
any of them.

### `agents/loop.js` — the turn engine

**Responsibility, exactly one: run one turn of one already-routed thread.**

| | |
|---|---|
| **Owns** | plan → act → observe; the reasoner call and its one retry; parsing; enforcing the agent's tool row; turning a gated call into an approval card; budget; thrash detection; running guards |
| **Does not** | know which agents exist, what any of them believes, how a thread gets a subject, what a tool does, when to route, or what the UI shows |

It reaches everything through three seams — an **agent module**, the **tool registry**, and
**state access** (`get`/`apply`). It imports no agent. Adding, removing or disabling one
never touches it.

### `agents/session.js` — when a turn runs

Routing a blank thread, latching it to its artifact, approving a gated card, cancelling
one. Routing is a policy about the studio, not a step inside a turn, and a thread that
never routes must never reach the engine.

### `agents/registry.js` — which agents exist

The only file that knows the roster. Registration, lookup, and enable/disable.

### `agents/guards.js` — checks on what an agent says

A guard is `(report) → correction | null`. The engine runs them without knowing what any
of them check. A guard corrects; it never rewrites — the agent's words stay in the
transcript with the correction beneath them.

### `agents/transcript.js` — thread memory

The recent transcript plus a rolling summary beneath it. A policy about what an agent
remembers, not a step in running a turn.

## An agent is a module

One file. `defineAgent()` refuses an incomplete one rather than half-registering it.

```js
export default defineAgent({
  id: 'shot',
  title: 'Shot',
  job: 'make one shot of the film good',   // the router reads this to choose
  tools: [...],                             // its authority; the gate refuses anything else
  system: () => '...',                      // its system prompt
  context: (project, thread) => '...',      // the live facts it needs this turn
  latch: ({ project, title, videoSlot, imageSlot }) => ({ project, subjectId }),
  guards: [],                               // optional extra output checks
  enabledByDefault: true,
});
```

`agents/index.js` is the whole roster. Importing it is what makes an agent exist.

`latch()` is how a kind acquires its one artifact — a shot creates a shot, a bible entry
creates an entry, an edit thread *attaches* to a shot that already has takes and creates
nothing. The session does not know the difference.

### Enable / disable

One override map, `override ?? enabledByDefault`, persisted per browser. A disabled agent
is not offered to the router **and** refuses to run, saying which of the two it was. It is
never silently replaced by another agent.

`audio` ships **off**: `speak` is not built, and an agent that promises work it cannot do
is worse than an absent one.

## Tools

`{ name, input } → { output, cost }`. Every result becomes a message rendered inline.

- **Free** — `read` `write` `order` `choose` `cite` `tag`. Run without asking.
- **Metered** — `compose` `direct`. One reasoner call, no approval, no money.
- **Gated** — `still` `shoot` `edit`. Real money. The engine turns the call into a card
  showing the exact prompt and the exact ordered references, and nothing is sent until a
  person approves it.

A tool declares its own `validate()`, which runs before anything is mutated.

## Concurrency

Agents run independently — several shots progress while you attend to one.

The engine never holds a snapshot of the project and writes it back; the later writer
would erase the other agent's work. It reads live through `get()` and mutates through a
serialized `apply()`. A tool still computes against a snapshot, but only what it *changed*
is laid onto the live project (`state/merge.js`): reference inequality identifies the
touched shot, the tool's result decides ordering, and a shot created by another run is
never deleted by an older one.

The shell keeps a **set** of running threads. The composer locks only the thread whose own
agent is working.

**The limit:** the loop lives in the browser, so a turn stops when the tab closes. Video
renders survive it — their task id is durable and polling resumes on the next load — but a
turn in progress does not. Moving the loop server-side is the open decision.

## Rules that shaped the code

These are load-bearing. Breaking one produces a bug that looks like something else.

- **The prompt is the prompt.** Nothing wraps, compiles or appends at send time. What the
  thread shows is what the model receives. `operations.animate()` will prepend camera
  language unless the cinematography fields are left unset — so `shoot` passes only
  `motion`.
- **Never substitute a default — no fallbacks.** An unknown id resolves to nothing; an
  unbound slot refuses; a missing skills directory is an error, not an empty library; a
  plate with no role is refused rather than filed as a character. Above all, **broken and
  absent are different answers**: a saved film that will not parse is reported, never
  replaced by a blank one.
- **Duration, ratio and resolution are parameters, never prompt text.**
- **Consistency is attachment, not description.** A plate rides in the request; the prompt
  cites it and does not re-describe it.
- **Every model promise needs a deterministic check.** Citation numbers within range,
  dialogue preserved, no parameters in prompt text, no claiming work that did not happen.
- **Reference order is the citation numbering.** The Nth reference is image N. Reordering
  is a data operation; prompt text is never rewritten to compensate.
- **`promptUsed` is recorded at send time**, never reconstructed. A take must explain
  itself later.
- **An editing task locks ratio and duration.** Sending either fails the request outright.

## Wire contracts worth knowing

- Video is asynchronous: start returns a task id, then poll.
- An editing task locks ratio and duration — sending either fails with
  `InvalidParameter.TaskTypeConstraint`. Resolution is still honoured.
- `duration: 'auto'` omits the field entirely.
- Generated media URLs expire in about a day — takes and plates keep the media store's
  durable copy.
- Photoreal people must ride as a registered `image_asset_id`, never a raw URL.
