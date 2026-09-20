# API quota regression results

New cache tests: passed. Full-suite comparison: no additional failing test names.

The full suite is NOT fully green when the known failures below remain.

Baseline: # tests 243, # pass 241, # fail 2

Patched: # tests 265, # pass 263, # fail 2

- an editorial continuation resumes a missing source generation exactly through the durable backfill worker
- protected monitor status exposes compact persisted diagnostics without article bodies

Production deployment is blocked until the CLI-only production changes are reconciled and browser/Blob checks pass.
