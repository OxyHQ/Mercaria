# Classify the reviewed image publisher

The credential-based census correctly finds `publish-reviewed-images.yml`. It is now explicitly classified as manual, main-only ECR publication, with ECS promotion remaining a separate root operation. Credential detection and exact set equality are unchanged.

The existing 48-test deployment coverage suite reproduces 47 PASS / 1 FAIL before the classification and 48 PASS afterward. The same static suite/configuration runs both times. No DB query, package install, registry adoption, image publication or deployment is involved.

The default package runner first failed its global PostgreSQL setup because localhost:5435 was absent. A static-only config next failed an incomplete shared installation import. Both setup failures are retained, not counted as product regressions. The retained configuration uses the actual previously installed @oxy.so/db migration module from the owned final-adoption worktree; no mock or replacement implementation. Required complete CI remains pending.

Command: `bun run --cwd packages/backend test --config ../../.integration-evidence/publisher-census/vitest.config.mjs`. The retained config is copied here for review; execution used the private path.
