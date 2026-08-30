# Status

What works, what does not, and the decisions still open.

## Works, end to end against real models

| | Agent | Proven by |
|---|---|---|
| Video from a prompt | `shot` | a 10s Seedance 2.5 take, 720p |
| Edit a video | `edit` | a Seedance 2.5 editing task on an existing take |
| Storyboard | `storyboard` | a six-panel board |
| Reference plate | `bible` | a plate, filed and citable |

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
- **Staleness.** A changed plate does not yet mark the shots citing it, so `⚠` never fires.
- **Example shots.** Promoting takes into an evidence library agents can read.

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
   Shipping `.agents` via `extraResources` would let asar back on.

## Bugs worth remembering

Each of these is now covered by a test.

- The router's answer was parsed with the **tool-call** rules, so every valid route was
  discarded as malformed and everything fell through to "ask".
- **`write` accepted any string as a model slot.** An agent wrote `model: "storyboard"`,
  stored silently, then refused to compose against a slot that does not exist.
- A **bible thread owns an entry, not a shot**, so `compose` and `still` failed on every
  call and the agent looped five times.
- An agent **fabricated a render queue** — "queued… will process unattended… you will be
  notified" — after running only `write`. There is no queue. The guard that catches this
  first fired on an *honest* sentence too, which is its own kind of failure.
- Concurrent turns each wrote back **a whole project computed from their own snapshot**, so
  the later writer erased the other agent's work.
- **Media URLs expire in about a day.** Takes now keep the media store's durable copy.
- A **hidden tab rendered the transcript blank** — a frozen entry animation held every
  message at `opacity: 0`.
- The **packaged app could not reach ModelArk at all**: Node builds its CA store from the
  environment at startup, so setting `NODE_USE_SYSTEM_CA` inside `main.cjs` did nothing.
- **`next build` clobbers a running `next dev`** — same `.next` directory.
