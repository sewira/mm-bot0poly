# MM Agent Team — install & operating guide

Five Claude Code subagents that run the market making project end to end. They are
**adaptive by construction**: no agent holds a single strategy number in its prompt.
All thresholds, parameters, and rules live in the docs (`00`–`03`) and the logs; every
agent reads them fresh per invocation. Change the doc once → every agent behaves
differently next run. mm-librarian is the mechanism that keeps that true.

## Install

```bash
# from your bot repo root
cp -r claude-agents/.claude/agents/ .claude/agents/
# expects your docs at docs/00..03_*.md and logs at logs/
# (adjust the paths inside the agent files if yours differ)
# restart your Claude Code session — agents load at session start
```

Existing setup note: these complement your `polymarket-quant` reviewer agent and the
`polymarket-strategy` skill. Strategist/builder/grader/reviewer reference that skill
via `skills:` frontmatter; mm-librarian is the only agent allowed to edit SKILL.md.

## The team

| Agent | Role | Tools posture | Invoke when |
|---|---|---|---|
| **mm-strategist** | Skeptical strategy owner. Evaluates/proposes changes; verdicts ADOPT / TEST FIRST / REJECT | Read-only + web | "Should we change X?", fee regime news, any new idea |
| **mm-builder** | Implements per build plan phases A→D, refuses to skip; safety code (breaker, caps, logging) before features | Read/Write/Edit/Bash | All coding tasks |
| **mm-grader** | Adversarial examiner. Computes the report card from logs, binary PASS/FAIL on stage gates | Read + Bash (compute only) | After dry-run windows, before ANY capital decision, weekly pulls |
| **mm-reviewer** | Runs daily/weekly/monthly rituals; keeps the decision journal; grades your past predictions | Read + journal write | The §8.3 cadence, every stage gate |
| **mm-librarian** | Consistency keeper. Propagates changes across docs/skill/agents; verifies fee facts on the web | Read/Edit/Write + web | After every change, gate transition, monthly minimum |

## The loops

**Change loop (this is the "adaptive" part):**
```
idea → mm-strategist (verdict) → if ADOPT: edit 03 → mm-librarian (propagate + journal)
     → mm-builder (implement against the NEW doc) → mm-grader (measure the effect)
     → mm-reviewer (grade your prediction at its review date)
```

**Operating loop:**
```
daily    → mm-reviewer (3-line check)
weekly   → mm-grader (metric pull) → mm-reviewer (drift interpretation)
monthly  → mm-grader (full report) → mm-reviewer (written verdict: scale/hold/restrict/kill)
gate     → mm-grader (binary PASS/FAIL) → mm-reviewer (journal the commitment)
```

## Separation of powers (why five agents, not one)

- The agent that **builds** never grades its own work (builder ≠ grader).
- The agent that **grades** never proposes strategy fixes for bad grades (grader ≠ strategist) —
  prevents threshold-shopping.
- The agent that **records** never decides (reviewer journals overrides AS overrides).
- The agent that **syncs** never resolves substantive conflicts (librarian routes them).
- mm-grader explicitly flags goalpost-moving: thresholds loosened right after a FAIL.

This mirrors how desks separate trading, risk, and ops. The friction is the feature.

## Invocation examples

```
Use the mm-strategist subagent: "Polymarket announced fee changes today — does our
edge survive? Check the official fee page."

Use the mm-builder subagent: "Implement Phase B item 7: the news circuit breaker
per 03 §3.7, with tests."

Use the mm-grader subagent: "Grade the dry-run window 2026-06-15 to 2026-06-29
against the dry-run stage gate."

Use the mm-reviewer subagent: "Run the monthly review for June."

Use the mm-librarian subagent: "We adopted convex skew exponent 2.0 instead of the
tan() variant — propagate."
```

## Ground rules the whole team obeys

1. Docs and logs beat memory. Always.
2. Fee/rebate facts are verified on the web, dated, and considered stale after 30 days.
3. Unproven (< 100 fills) = untradeable, not "probably fine."
4. Partial green is red. Gates are binary.
5. History is append-only. Wrong past entries get corrected by NEW entries.
6. Killing the book on the pre-committed criteria is a success mode, not a failure.
