# Development goals

This directory contains finishable outcomes and their completion evidence.
[Core design](../core-design/README.md) contains the long-term architecture.
Goals reference that design; they do not maintain a second architecture.

ANC is not yet 0.1.0-ready or 1.0.0-ready. Existing code and generated data have
no backward-compatibility entitlement. A goal must not add old-format support,
transition adapters, or dual outputs solely to preserve the unreleased implementation.

## Naming and lifecycle

- Active goals: `docs/goals/NNNN-short-name.md`, starting at `0001`, with unique
  increasing four-digit numbers. Check both active and archive directories before
  assigning the next number. Do not renumber or reuse a completed goal's number.
- Each goal states one independently meaningful desired outcome, evidence of
  completion, material bounds, and current status. Size or implementation layers
  alone do not justify splitting one completion judgment into several goals.
- Status starts as `ready`, changes to `in progress` when execution begins, and
  becomes `completed` only with recorded evidence and any required maintainer
  acceptance. Do not mark a goal completed because its design document exists.
- Move a completed goal to `docs/goals/archive/` with the same filename. Record
  completion date, implementation commit/PR, verification results, and relevant
  limitations before moving it; update links that pointed to its active location
  and relative links inside the moved file.
- An abandoned or superseded goal is not a completed goal. Record its decision and
  link its successor explicitly; do not put it in the completed-goal archive.
- Historical `docs/plans/` files remain reference material. Do not create new
  development goals there or treat old ticket completion claims as current evidence.

## Active goals

| Goal | Status | Completion judgment |
| --- | --- | --- |
| [0001 — Unified public query model](0001-unified-public-query-model.md) | Ready | The real built and packaged product uses SQLite/WASM for the accepted query capabilities, with static reading and verified performance/failure behavior |

No goal is completed yet under this numbering scheme. Completing 0001 establishes
its bounded data capability, not blanket readiness of the entire product.
