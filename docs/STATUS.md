# Status

What works, what does not, and the decisions still open.

## Works, end to end against real models

| | Agent | Proven by |
|---|---|---|
| Video from a prompt | `shot` | a 10s Seedance 2.5 take, 720p |
| Edit a video | `edit` | a Seedance 2.5 editing task on an existing take |
| Storyboard | `storyboard` | a six-panel board |
| Reference plate | `bible` | a plate, filed and citable |
| Citation | `cite` on shot threads | plate attached as an ordered ref, rides the render request; prompt cites it by number |
| Refinement | `direct` + `attach` on bible threads | notes revise the plate prompt without forgetting earlier ones; the current plate rides as a reference so the likeness holds; reverting to an earlier render is free |

Each runs: route → compose under the bound spec → approval card showing the exact prompt →
approve → render inline.

Around them: the shell (rail, thread pane, composer), multi-project Films, the Skills
screen with provenance, per-thread budgets, live render tracking that survives a reload,
and a macOS package.

## Not built

- **Audio.** `speak` is unimplemented; the agent ships switched off.
- **Fork.** Sibling and next. Shot creation should move entirely to forking.
- **The fleet view.** Several agents working at once is supported by the harness, but
  there is no screen that shows the whole fleet.
- **Example shots.** Promoting takes into an evidence library agents can read.

Staleness fires now: re-rendering a plate marks every shot with a chosen take citing it.

## Open decisions

1. **Where the loop runs.** In the browser today: simplest, and the transport kit is built
   for it. A turn stops when the tab closes (renders survive — their task id is durable).
   Moving it server-side is what a real fleet needs.
2. **Where projects persist.** `localStorage`. Fine for now, a poor home for transcripts
   and takes worth keeping. The kit already has cloud project saves.
3. **The image spec.** `plate-pe` was written for BRAVO because the Seedream slots had
   nothing bound and an unbound slot refuses to compose. It is not a vendor document and
   says so. Replace it from the Skills screen when an official one exists.
4. **Packaging size.** `asar: false` costs a 598 MB bundle, because the skills library is
   resolved through `process.cwd()` and `process.chdir` cannot enter an asar archive.
   Shipping `skills/` via `extraResources` would let asar back on.