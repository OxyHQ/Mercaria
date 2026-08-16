#!/usr/bin/env bun

/**
 * Mutation-tests `validate-no-mongo.mjs`.
 *
 * A guard that has only ever been seen to pass is indistinguishable from one
 * that cannot fail — and this one is especially easy to break silently, because
 * every part of it is a regex or a file listing and both fail QUIET. A broken
 * `git ls-files` reports a clean tree. A regex with a typo reports a clean tree.
 * Each case below breaks exactly one thing and requires the guard to fail, and
 * to fail with the words that identify the right rule.
 *
 * The cases that must PASS matter as much: this repository's comments discuss
 * Mongo constantly, on purpose, and both loggers carry a Mongo-URI redaction
 * pattern that is wanted. A version of this guard that fired on either would be
 * disabled by whoever hit it first.
 *
 * Fixtures are real trees with a real `git init`, so the guard's actual file
 * listing runs rather than a stand-in for it.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-no-mongo.mjs");

/** Where mutated copies of the guard live — never inside a fixture tree. */
const mutantHome = await mkdtemp(join(tmpdir(), "no-mongo-mutants-"));

/**
 * Run the REAL validator against a scratch checkout.
 *
 * `realFloors` runs it with production vacuity floors, which is the only way to
 * see them fire; every other case relaxes them, since a fixture tree of six
 * files would otherwise fail for a reason that has nothing to do with Mongo.
 */
/**
 * Write a copy of the REAL guard with its `KNOWN_EXCEPTIONS` literal replaced.
 *
 * `KNOWN_EXCEPTIONS` is empty in this repository, which is the only thing that
 * has been making its reconciliation safe (#448) — so the exact-count branches
 * cannot be reached by any fixture tree, and a self-test that skipped them would
 * leave the mechanism arming itself on the first entry anyone adds, untested.
 *
 * This is a MUTATION of the shipped guard, not a re-implementation of it: every
 * line of the reconciliation under test is the one that ships, with one constant
 * substituted. It refuses to run unless the substitution demonstrably applied —
 * a mutation that never applied is indistinguishable from one that survived, and
 * against an EMPTY list the unmutated guard passes trivially, which would read
 * as coverage.
 */
async function mutatedValidator(root, entriesLiteral) {
  const source = await readFile(validator, "utf8");
  const marker = "const KNOWN_EXCEPTIONS = [];";
  if (!source.includes(marker)) {
    throw new Error(
      `the guard no longer spells its empty list \`${marker}\`, so this mutation cannot apply — `
      + "update the marker rather than deleting the cases that depend on it",
    );
  }
  const mutated = source.replace(marker, `const KNOWN_EXCEPTIONS = ${entriesLiteral};`);
  if (mutated === source || !mutated.includes(entriesLiteral)) {
    throw new Error("the KNOWN_EXCEPTIONS mutation did not apply, so the case below would measure nothing");
  }
  const path = join(root, "mutated-validate-no-mongo.mjs");
  await writeFile(path, mutated);
  return path;
}

async function runAgainst(files, { realFloors = false, removeAfterAdd = [], exceptions = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "no-mongo-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }

    // `-f` because a developer's global excludes file can legitimately ignore
    // `*.lock`, which would drop the lockfile fixture and make its case pass for
    // the wrong reason.
    Bun.spawnSync({ cmd: ["git", "-c", "init.defaultBranch=main", "init", "-q"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "add", "-A", "-f"], cwd: root });

    // Deleted AFTER `git add`, so the path stays in the index while the working
    // tree loses it. That divergence is real — a half-applied checkout or an
    // interrupted rebase produces it — and it is the only way to reach the
    // unreadable-file branch, which cannot be staged into existence.
    for (const path of removeAfterAdd) await rm(join(root, path), { force: true });

    const environment = { ...process.env, NO_MONGO_VALIDATOR_ROOT: root };
    if (!realFloors) environment.NO_MONGO_VALIDATOR_FIXTURE_FLOORS = "1";

    // OUTSIDE the fixture root on purpose: `git add -A -f` above would stage a
    // copy placed inside it, and the guard names every banned package by
    // definition, so it would then report ITSELF and the case would pass for
    // entirely the wrong reason.
    const proc = Bun.spawnSync({
      cmd: ["bun", exceptions === null ? validator : await mutatedValidator(mutantHome, exceptions)],
      cwd: repositoryRoot,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * A clean tree.
 *
 * It carries one file per live `KNOWN_EXCEPTIONS` entry, holding the text that
 * entry excuses — so every case below also exercises the exception path, and the
 * guard's "the list must only shrink" check has something to be satisfied by.
 * The stale-exception case is the one tree that deliberately omits it.
 *
 * THIS IS COUPLED TO THE LIVE LIST ON PURPOSE, and the coupling is the point:
 * the self-test then proves the real exceptions match real text, rather than
 * proving a synthetic list matches synthetic text. Adding an entry to the guard
 * means adding its file here; forgetting turns every case below red with a
 * message naming the entry. The cost shrinks as the list does.
 */
function filler(extra = {}) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "fixture",
        workspaces: { packages: ["packages/*"], catalog: { typescript: "~5.9.3" } },
        dependencies: { postgres: "3.4.9" },
        overrides: { ioredis: "5.11.1" },
      },
      null,
      2,
    )}\n`,
    "bun.lock": [
      "{",
      '  "lockfileVersion": 1,',
      '  "packages": {',
      '    "postgres": ["postgres@3.4.9", "", {}, "sha512-fixture=="],',
      '    "drizzle-orm": ["drizzle-orm@0.45.2", "", {}, "sha512-fixture=="],',
      "  },",
      "}",
      "",
    ].join("\n"),
    "packages/backend/src/db/postgres.ts": "export const dialect = 'postgres';\n",
    ...extra,
  };
}

const cases = [
  {
    name: "a clean PostgreSQL-only tree passes",
    files: filler(),
    expectFailure: false,
  },

  // ------------------------------------------------------------ manifests ---
  {
    name: "a dependency on mongoose is rejected",
    files: filler({
      "packages/backend/package.json": `${JSON.stringify(
        { name: "@mercaria/backend", dependencies: { mongoose: "^8.24.0" } },
        null,
        2,
      )}\n`,
    }),
    expectFailure: true,
    expectOutput: "dependencies declares mongoose",
  },
  {
    name: "a devDependency on mongodb-memory-server is rejected",
    files: filler({
      "packages/backend/package.json": `${JSON.stringify(
        { name: "@mercaria/backend", devDependencies: { "mongodb-memory-server": "^10.0.0" } },
        null,
        2,
      )}\n`,
    }),
    expectFailure: true,
    expectOutput: "devDependencies declares mongodb-memory-server",
  },
  {
    name: "a catalog entry is rejected",
    files: filler({
      "package.json": `${JSON.stringify(
        { name: "fixture", workspaces: { packages: ["packages/*"], catalog: { mongodb: "^6.10.0" } } },
        null,
        2,
      )}\n`,
    }),
    expectFailure: true,
    expectOutput: "workspaces.catalog declares mongodb",
  },
  {
    name: "an override is rejected",
    files: filler({
      "package.json": `${JSON.stringify({ name: "fixture", overrides: { mongoose: "8.24.0" } }, null, 2)}\n`,
    }),
    expectFailure: true,
    expectOutput: "overrides declares mongoose",
  },
  {
    // The regression this check exists for. `@mercaria/backend` described itself
    // as an "Express 5 / Mongoose / Socket.io backend" while every dependency
    // check above passed, because a description declares nothing. The most
    // visible line in the manifest was the one the guard could not read.
    name: "a description claiming Mongoose is rejected",
    files: filler({
      "packages/backend/package.json": `${JSON.stringify(
        { name: "@mercaria/backend", description: "Express 5 / Mongoose / Socket.io backend for Mercaria" },
        null,
        2,
      )}\n`,
    }),
    expectFailure: true,
    expectOutput: "description claims Mongoose",
  },
  {
    name: "a keyword claiming MongoDB is rejected",
    files: filler({
      "packages/backend/package.json": `${JSON.stringify(
        { name: "@mercaria/backend", keywords: ["api", "MongoDB"] },
        null,
        2,
      )}\n`,
    }),
    expectFailure: true,
    expectOutput: "keywords claims MongoDB",
  },
  {
    // The distinguishing shape for the word anchor. A substring match would
    // reject both of these, and a maintainer who hit that would delete the
    // check rather than argue with it — a gate that cries wolf gets disabled by
    // whoever trips over it next. Without this fixture, `/mongo/i` and
    // `/\bmongo(?:db|ose)?\b/i` are indistinguishable.
    name: "a description containing mongo inside another word passes",
    files: filler({
      "packages/backend/package.json": `${JSON.stringify(
        { name: "@mercaria/backend", description: "Ranked among the fastest, deployed in Mongolia" },
        null,
        2,
      )}\n`,
    }),
    expectFailure: false,
  },

  // ------------------------------------------------------------- lockfile ---
  {
    name: "a lockfile resolution is rejected even with clean manifests",
    files: filler({
      "bun.lock": [
        "{",
        '  "lockfileVersion": 1,',
        '  "packages": {',
        '    "postgres": ["postgres@3.4.9", "", {}, "sha512-fixture=="],',
        '    "mongoose": ["mongoose@8.24.0", "", { "dependencies": { "mongodb": "6.10.0" } }, "sha512-fixture=="],',
        "  },",
        "}",
        "",
      ].join("\n"),
    }),
    expectFailure: true,
    expectOutput: "resolves mongoose",
  },
  {
    name: "a NESTED lockfile resolution is rejected too",
    files: filler({
      "bun.lock": [
        "{",
        '  "lockfileVersion": 1,',
        '  "packages": {',
        '    "postgres": ["postgres@3.4.9", "", {}, "sha512-fixture=="],',
        '    "@some/pkg/mongodb": ["mongodb@6.10.0", "", {}, "sha512-fixture=="],',
        "  },",
        "}",
        "",
      ].join("\n"),
    }),
    expectFailure: true,
    expectOutput: "resolves mongodb",
  },
  {
    name: "a package whose NAME merely contains a banned one is not rejected",
    files: filler({
      "bun.lock": [
        "{",
        '  "lockfileVersion": 1,',
        '  "packages": {',
        '    "mongoose-helper": ["mongoose-helper@1.0.0", "", {}, "sha512-fixture=="],',
        '    "not-mongodb": ["not-mongodb@2.0.0", "", {}, "sha512-fixture=="],',
        "  },",
        "}",
        "",
      ].join("\n"),
    }),
    expectFailure: false,
  },

  // -------------------------------------------------------- source imports ---
  {
    name: "an import statement is rejected",
    files: filler({
      "packages/backend/src/db/legacy.ts":
        "import mongoose from 'mongoose';\nexport const connect = () => mongoose.connect('');\n",
    }),
    expectFailure: true,
    expectOutput: "imports a Mongo driver",
  },
  {
    name: "a require call is rejected",
    files: filler({
      "packages/backend/src/db/legacy.cjs": "const { MongoClient } = require('mongodb');\nmodule.exports = MongoClient;\n",
    }),
    expectFailure: true,
    expectOutput: "imports a Mongo driver",
  },
  {
    name: "a dynamic import is rejected",
    files: filler({
      "packages/backend/src/db/legacy.ts":
        'export const boot = async () => (await import("mongodb-memory-server")).MongoMemoryServer;\n',
    }),
    expectFailure: true,
    expectOutput: "imports a Mongo driver",
  },
  {
    name: "a subpath import is rejected",
    files: filler({
      "packages/backend/src/db/legacy.ts": "import { Schema } from 'mongoose/lib/schema';\nexport { Schema };\n",
    }),
    expectFailure: true,
    expectOutput: "imports a Mongo driver",
  },

  // ------------------------------------------------------- config and env ---
  {
    name: "MONGODB_URI in a workflow is rejected",
    files: filler({
      ".github/workflows/deploy.yml": "jobs:\n  deploy:\n    env:\n      MONGODB_URI: ${{ secrets.MONGODB_URI }}\n",
    }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    name: "MONGODB_URI in an env template is rejected",
    files: filler({ "packages/backend/.env.example": "DATABASE_URL=\nMONGODB_URI=\n" }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    name: "MONGODB_URI in a .github shell script is rejected",
    files: filler({ ".github/scripts/deploy.sh": "#!/usr/bin/env bash\naws ssm get-parameter --name MONGODB_URI\n" }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    // The distinguishing shape for the case-insensitive read. Without a fixture
    // in a casing other than the canonical one, a case-SENSITIVE regex passes
    // every other case in this file too, so the difference would go untested.
    name: "a lowercased mongodb_uri config key is rejected",
    files: filler({
      "packages/backend/src/config/legacy.ts": "export const keys = { mongodb_uri: process.env.DATABASE_URL };\n",
    }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    name: "a suffixed MONGODB_URI_LEGACY is rejected",
    files: filler({ ".github/workflows/deploy.yml": "env:\n  MONGODB_URI_LEGACY: ${{ secrets.OLD }}\n" }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    name: "a mongodb:// connection string in a source file is rejected",
    files: filler({
      "packages/backend/src/db/legacy.ts": "export const uri = 'mongodb://localhost:27017/mercaria';\n",
    }),
    expectFailure: true,
    expectOutput: "carries a mongodb:// connection string",
  },
  {
    name: "a mongodb+srv:// connection string in a compose file is rejected",
    files: filler({
      "docker-compose.yml": "services:\n  api:\n    environment:\n      - URI=mongodb+srv://user:pw@cluster/mercaria\n",
    }),
    expectFailure: true,
    expectOutput: "carries a mongodb:// connection string",
  },

  // ------------------------------------------ prose and redaction are safe ---
  {
    name: "backticked prose about Mongo does NOT fire",
    files: filler({
      "packages/backend/src/db/postgres.ts":
        "/**\n"
        + " * Replaces the old `import mongoose from mongoose` boot path. Every model that\n"
        + " * used Mongoose now goes through drizzle; nothing requires mongodb any more,\n"
        + " * and the Mongo connection string this once read is gone.\n"
        + " */\n"
        + "export const dialect = 'postgres';\n",
    }),
    expectFailure: false,
  },
  {
    // The distinguishing shape for the `from|require|import` prefix. Backticked
    // prose is caught by the QUOTE anchor alone, so without a quoted module name
    // outside import position, deleting the prefix entirely leaves every case
    // green — measured. This is the input that tells the two apart.
    name: "a QUOTED module name that is not an import does NOT fire",
    files: filler({
      "packages/backend/src/db/postgres.ts":
        "// Nothing in this package loads 'mongoose' any more; the driver key was\n"
        + '// "mongodb" and both are gone. Kept as a note for anyone grepping.\n'
        + "export const driver = 'postgres';\n",
    }),
    expectFailure: false,
  },
  {
    // The guard names every banned package and both URI shapes by necessity, and
    // this file carries a fixture for each. Scanned, the pair reports itself on
    // every run — which is exactly what happened the moment they were first
    // committed and became visible to `git ls-files`.
    name: "the guard's own source and self-test are not their own subject",
    files: filler({
      "scripts/validate-no-mongo.mjs":
        "const BANNED = ['mongoose', 'mongodb', 'connect-mongo'];\n"
        + "const URI = /\\bmongodb(?:\\+srv)?:\\/\\//i;\n"
        + "const ENV = /\\bMONGODB_URI/i;\n",
      "scripts/test-validate-no-mongo.mjs":
        "const fixture = \"const { MongoClient } = require('mongodb');\";\n"
        + "const uri = 'mongodb://localhost:27017/mercaria';\n"
        + "const env = 'MONGODB_URI=';\n",
    }),
    expectFailure: false,
  },
  {
    name: "the loggers' Mongo-URI REDACTION pattern does NOT fire",
    files: filler({
      "packages/backend/src/utils/logger.ts":
        "const REDACT = /\\b(?:https?|wss?|redis|rediss|mongodb(?:\\+srv)?):\\/\\/[^\\s\"'<>]+/gi;\n"
        + "const SENSITIVE_KEYS = ['mongouri', 'dbname'];\n"
        + "export const sanitise = (line: string) => line.replace(REDACT, '[REDACTED]');\n",
    }),
    expectFailure: false,
  },
  {
    // Markdown's exemption comes from the scan sets — no glob in the guard can
    // match a `.md` path — rather than from an exclusion filter. An explicit
    // filter was written and then deleted, because mutation-testing showed no
    // input could tell the two versions apart. So this case cannot be broken by
    // touching an exclusion; it fires if someone widens the SOURCE_FILE pattern,
    // which is the change that would actually put docs back in scope.
    name: "a markdown file describing the migration does NOT fire",
    files: filler({
      "docs/MONGO-TO-POSTGRES.md":
        "The copier read `MONGODB_URI` (a mongodb://host/db string) and wrote Postgres.\n"
        + "```ts\nimport mongoose from 'mongoose';\n```\n",
      "packages/backend/README.md": "Set MONGODB_URI to nothing — it is gone. Old value: mongodb://localhost:27017.\n",
    }),
    expectFailure: false,
  },

  // --------------------------- the retired standing removal ----------------
  //
  // `TASK_SECRET_REMOVALS: MONGODB_URI` was briefly excused. It named the secret
  // in order to strip it from every rendered task definition, which was load-
  // bearing while a Terraform apply could still reintroduce it — the definition
  // is derived from the LIVE one, so a secret nobody names is carried forward.
  //
  // That threat model closed upstream: oxy-infra `099db84` records DATABASE_URL
  // and no MONGODB_URI for this service, and `/oxy/mercaria/MONGODB_URI` is
  // deleted from SSM, so a name that comes back now fails task provisioning
  // loudly instead of resurrecting a secret. The directive and its exception are
  // both gone, and the absence assertion lives here instead, in CI.
  //
  // These two cases are what makes that a decision rather than a drift: the
  // retired directive is now an ordinary finding, and so is every other shape a
  // reintroduction would take in that file.
  {
    name: "the retired removal directive is now an ordinary finding",
    files: filler({
      ".github/workflows/deploy-aws.yml": "        env:\n          TASK_SECRET_REMOVALS: MONGODB_URI\n",
    }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    // `TASK_SECRET_OVERRIDES_JSON` supplies secrets by SSM path in this file, so
    // an ARN is the other shape a reintroduction would take — and the one a
    // scanner looking only for a bare variable name would miss.
    name: "the deploy workflow FAILS on an SSM ARN for the parameter",
    files: filler({
      ".github/workflows/deploy-aws.yml":
        "        env:\n"
        + '          TASK_SECRET_OVERRIDES_JSON: {"MONGODB_URI":'
        + '"arn:aws:ssm:us-west-2:237343248947:parameter/oxy/mercaria/MONGODB_URI"}\n',
    }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },

  {
    // A tracked path the working tree does not have. Before this was handled the
    // guard threw an ENOENT stack trace out of the middle of the scan: no
    // verdict, and a failure that reads like a bug in the guard rather than a
    // fact about the tree. Met in the wild on a stale worktree, not imagined.
    //
    // It must FAIL rather than skip quietly, because the scan really was
    // incomplete — the unread file is exactly where a reintroduction could sit.
    name: "a tracked file missing from the working tree fails loudly, not with a stack trace",
    files: filler({
      "packages/backend/src/db/legacy.ts": "export const uri = 'postgres://localhost/x';\n",
    }),
    removeAfterAdd: ["packages/backend/src/db/legacy.ts"],
    expectFailure: true,
    expectOutput: "tracked by git but could not be read",
  },

  {
    // Not Mercaria's own spelling, and included for that reason: a sibling Oxy
    // service carries `MONGO_URI` on its live task definition, and a guard
    // written for `MONGODB_URI` alone called that repository clean while the
    // secret was still there. Without this fixture the two patterns are
    // indistinguishable here, since nothing in this tree uses either spelling.
    name: "the no-DB spelling MONGO_URI is caught too, and reported as itself",
    files: filler({
      "packages/backend/src/config/legacy.ts": "export const uri = process.env.MONGO_URI;\n",
    }),
    expectFailure: true,
    expectOutput: "names MONGO_URI",
  },

  // ------------------------------------------------------- self-protection ---
  {
    name: "a broken file listing cannot pass silently (vacuity floors)",
    files: {
      "packages/backend/src/db/postgres.ts": "export const dialect = 'postgres';\n",
    },
    realFloors: true,
    expectFailure: true,
    expectOutput: "below the 900 floor",
  },
  {
    // `KNOWN_EXCEPTIONS` is empty here: Mercaria has no surviving Mongo
    // reference in any scanned surface, so there is nothing to excuse. No
    // fixture TREE can therefore reach the reconciliation's branches — with
    // nothing to go stale, a tree-driven shrink case could never fail, and a
    // case that cannot fail is worse than no case.
    //
    // That is why the four cases BELOW mutate the guard's own constant instead
    // of building a tree, and why this one stays: it pins the premise they rest
    // on. The day somebody adds the first entry it goes red, and the fix is to
    // convert those four to ordinary tree-driven cases against the real entry —
    // not to delete this one.
    name: "KNOWN_EXCEPTIONS is empty, so no fixture TREE can reach the count branches",
    assertGuardSource: (source) => /const KNOWN_EXCEPTIONS = \[\];/.test(source),
  },

  // ------------------------------------------- the exact-count mechanism ---
  // #448. These four run the REAL reconciliation with one constant substituted,
  // because an empty list can reach none of its branches by fixture. Without
  // them the mechanism arms itself on the first entry anyone adds, untested —
  // and the first entry is exactly when nobody is thinking about it.

  {
    name: "an exception matching its exact declared count passes",
    files: filler({
      "packages/backend/src/legacy/notes.ts": 'import mongoose from "mongoose";\n',
    }),
    exceptions: '[{ file: "packages/backend/src/legacy/notes.ts", pattern: "mongoose", '
      + 'count: 1, reason: "fixture" }]',
    expectFailure: false,
    expectOutput: "each matched their exact declared count",
  },
  {
    name: "an excusing entry cannot cover a SECOND Mongo reference in the same file",
    // The hole itself: file + text is a PREDICATE, not an identity, so without a
    // count the second import rides in behind the reasoned one — a database
    // driver returning to a service whose only store is PostgreSQL.
    files: filler({
      "packages/backend/src/legacy/notes.ts":
        'import mongoose from "mongoose";\n'
        + 'import { connect } from "mongoose";\n',
    }),
    exceptions: '[{ file: "packages/backend/src/legacy/notes.ts", pattern: "mongoose", '
      + 'count: 1, reason: "fixture" }]',
    expectFailure: true,
    expectOutput: "the count went UP",
  },
  {
    name: "an entry covering fewer than it declares fails as a DECREASE, naming the file",
    files: filler({
      "packages/backend/src/legacy/notes.ts": 'import mongoose from "mongoose";\n',
    }),
    exceptions: '[{ file: "packages/backend/src/legacy/notes.ts", pattern: "mongoose", '
      + 'count: 2, reason: "fixture" }]',
    expectFailure: true,
    expectOutput: 'in packages/backend/src/legacy/notes.ts 2 time(s), but only 1 matched — '
      + "the count went DOWN",
  },
  {
    name: "an entry declaring no count is refused by name, not silently honoured",
    // What arms the latent list: the reconciliation compares against `undefined`
    // otherwise, and the entry would excuse every occurrence of its shape.
    files: filler({
      "packages/backend/src/legacy/notes.ts": 'import mongoose from "mongoose";\n',
    }),
    exceptions: '[{ file: "packages/backend/src/legacy/notes.ts", pattern: "mongoose", '
      + 'reason: "fixture" }]',
    expectFailure: true,
    expectOutput: "declares no integer count >= 1",
  },
];

const guardSource = await readFile(validator, "utf8");

let failed = 0;
for (const testCase of cases) {
  // A source-level assertion, for a property of the GUARD rather than of a tree
  // it scans. Runs no fixture: there is nothing to put in one.
  if (testCase.assertGuardSource) {
    if (testCase.assertGuardSource(guardSource)) {
      console.log(`ok   ${testCase.name}`);
    } else {
      console.error(`FAIL ${testCase.name}: the guard source no longer satisfies this assertion`);
      failed += 1;
    }
    continue;
  }

  const { exitCode, output } = await runAgainst(testCase.files, {
    realFloors: testCase.realFloors === true,
    removeAfterAdd: testCase.removeAfterAdd ?? [],
    exceptions: testCase.exceptions ?? null,
  });
  const didFail = exitCode !== 0;

  if (didFail !== testCase.expectFailure) {
    console.error(
      `FAIL ${testCase.name}: expected ${testCase.expectFailure ? "a failure" : "a pass"}, `
      + `got exit ${exitCode}\n${output}`,
    );
    failed += 1;
    continue;
  }
  if (testCase.expectOutput && !output.includes(testCase.expectOutput)) {
    console.error(
      `FAIL ${testCase.name}: failed as expected, but the message never said `
      + `"${testCase.expectOutput}"\n${output}`,
    );
    failed += 1;
    continue;
  }
  console.log(`ok   ${testCase.name}`);
}

await rm(mutantHome, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} guard cases failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} guard cases passed.`);
