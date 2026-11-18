# Implementation Checklist

How to take one item from the 1.0.0 list (SPEC.md §10.2) to done. Each item has a
plan in [docs/plans/](docs/plans/); start a new one from
[plan-template.md](docs/plans/plan-template.md) for anything not covered.

## 1. Explore
- [ ] Read the plan, and the SPEC.md and ARCHITECTURE.md sections it links.
- [ ] Read the code it touches. The detector is pure; the shell (`index.js`) does all I/O.
- [ ] If the item depends on another plugin or server API, confirm the real API
      first (server source or the plugin's README), not from memory.

## 2. Plan
- [ ] Update the plan if exploring changed the approach. Note rejected alternatives.
- [ ] List test scenarios before coding: normal case, edge cases, and the failure
      the feature exists to prevent (a false alarm, a missed drag, a stale anchor).

## 3. Test and implement
- [ ] Pure logic goes in `src/` and gets its own `test/<module>.test.js` with
      synthetic tracks (see `test/detector.test.js`).
- [ ] Plugin wiring gets a case in `test/plugin.test.js` using `fakeApp()` and mock timers.
- [ ] Run `npm test` often. If a test looks wrong, fix it on purpose; never loosen
      a threshold just to get green.
- [ ] No runtime dependencies. Webapp code stays plain ES2015, no build step.

## 4. Verify
- [ ] Behaviour matches SPEC.md (defaults, published paths, notification paths).
- [ ] Structure matches ARCHITECTURE.md (module boundaries, pure vs I/O).
- [ ] Every per-vessel error is caught and logged; one bad vessel never stops a cycle.
- [ ] Any threshold you added or changed has its reason in docs/VALIDATION.md.

## 5. Document and commit
- [ ] Update SPEC.md / ARCHITECTURE.md if the change alters what they describe;
      tick the item in the plan.
- [ ] README (user-facing behaviour, config) and CHANGELOG (unreleased section).
- [ ] Comments read correctly a year from now: no "new", "now", "recently".
- [ ] `npm test` green, then commit straight to `main` (no PRs until 1.0.0) with a
      message that says why.

## Don't
- Don't use wind data: dropped on purpose (SPEC §2.5, §12).
- Don't place an anchor or radius from weak evidence; report an area instead (SPEC §2.4).
- Don't raise alerts on doubtful estimates unless the user turned that on (SPEC §2.7).
