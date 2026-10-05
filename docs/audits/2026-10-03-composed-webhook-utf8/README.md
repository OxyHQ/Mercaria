# Composed Mercaria webhook raw-byte regression

Source `6aa30b763865eda8a450aed1c34aa5a8e370510b` composes reviewed PR1043(`975e680a`) and1044(`de871d24`) on current main`9e546e66`. [proof.json](proof.json) pins the guard/test, unchanged MCP/billing/payment inputs and eight execution records. Main's newer dependency manifests are preserved; final published Oxy SDK adoption and full composed CI remain pending.

A real HTTP request signed for a valid JSON string containing U+FFFD was altered to contain an invalid0xff byte instead of that character's UTF-8 sequence. Decoding produced the same string. Before the guard, the actual app returned200 and stored1 provider event in PostgreSQL. After a round-trip UTF-8 check before SDK verification, it returns400 and stores0; the original valid string still returns200 and stores1. The fixture uses a synthetic secret and nonexistent payment: no charge or financial exploitation is claimed.

The guard changes no SDK cryptography, event mapping, namespace, scope or ledger logic. Three focused suites (webhook ingress plus both active-account MCP suites) pass29 tests; strict backend TS and scoped lint pass. The existing owned PG5575 server remains; harness-owned databases were dropped/read back. No deployment or new cohort was activated.
