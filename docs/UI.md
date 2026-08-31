# The UI architecture

The UI is Model-View-Update with a command layer — which is the current best practice for agent applications, and it is now written down so every change can be judged against it.

## The law

1. **One state, one writer.** The project is a single immutable object. Every mutation is `apply(pureFn)` in the shell; `state/project.js` holds the pure updaters and is the only module that touches project storage. Whole-project swaps (open, new, delete) go through `adopt()`, which bumps the run epoch.
2. **Runs carry an epoch.** Every agent run captures the epoch at launch; its `apply` becomes a no-op if the project was swapped underneath it. A run started in one film can never write into another.
3. **Views are pure functions of the project.** Cross-cutting judgments — when a run is stale, when it is resumable, how elapsed time prints — live in `state/selectors.js`, consumed identically by controllers and views. A view never re-derives a controller decision.
4. **Tools own film, bible, and sequences — nothing else.** `state/merge.js` reconciles those three keys and now throws loudly if a tool result touches threads, activity, or look. Iteration records remain append-only, enforced the same way.
5. **Failures are rendered, never swallowed.** Load failures block the boot screen with their message; save/recovery failures show a persistent banner. The quota message ("nothing new is being persisted") is now impossible to miss.
6. **Long-running work must prove it is alive.** Activity records and run nodes carry heartbeats; the rail and flow panel show liveness, and anything without a live heartbeat is labeled stalled, never shown as an open-ended clock. Sequence activities are pruned at load — before thread reconciliation — because their poller provably died with the page.
7. **The run's true home is the server.** Today `runSequence` executes in the tab, guarded by a per-sequence lock, atomic run initialization, and boot resume. The architectural destination — matching the AG-UI / server-boundary pattern the industry has converged on — is a server-side runner the UI merely observes. The heartbeat/resume machinery is the honest bridge until then.
