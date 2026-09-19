/**
 * Every ceiling the inspection pipeline refuses at, in ONE place (#1015 W4,
 * W12 threats 5–7).
 *
 * ## Why the numbers live here and not beside the parsers
 *
 * Each parser in this directory is a bounded reader of hostile bytes, and the
 * bound is the only thing standing between a creator's upload and the worker's
 * memory. A ceiling spelled inline is a ceiling nobody can audit: the question a
 * reviewer actually asks is *"what is the worst one file can cost"*, and that is
 * answerable only if every limit is visible at once. So they are constants here,
 * every one of them carries the reasoning for its VALUE, and
 * `limits.test.ts` asserts the handful of relationships between them that a
 * thoughtless edit would break.
 *
 * ## The budget this adds up to
 *
 * One file costs at most {@link MAX_INSPECTED_FILE_BYTES} of raw bytes, plus at
 * most {@link MAX_CONTAINER_ENTRY_EXPANDED_BYTES} for the single container part
 * the 3MF reader inflates, plus the working set of the manifold check — bounded
 * by {@link MAX_WATERTIGHT_TRIANGLES} edges. The worker concurrency in
 * `queue/constants.ts` is chosen against that figure rather than against a feel
 * for throughput, which is why the two files reference each other.
 *
 * ## A ceiling is a VERDICT, never an exception
 *
 * Exceeding one produces `refused_too_large` or `corrupt`
 * ({@link AssetInspectionVerdict}), recorded against the file with the processor
 * that refused. Nothing here throws, and nothing here retries: a 300 MB upload
 * will be 300 MB on the second attempt too, and a job that threw would spend the
 * retry budget rediscovering the same fact while the creator's screen said
 * nothing.
 */

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * The largest file the pipeline will read at all — 256 MiB.
 *
 * Chosen from the inspect-then-refuse asymmetry: the whole file is held in memory
 * because every parser here needs random access (binary STL's length formula,
 * GLB's chunk table, a zip's central directory is at the END), and a streaming
 * rewrite would buy a higher ceiling at the cost of being the only parser family
 * in the repo nobody can test exhaustively. 256 MiB times the digital worker's
 * concurrency is the memory this queue may hold, and that product is what
 * `DIGITAL_WORKER_CONCURRENCY` is derived from.
 *
 * A file above it is `refused_too_large` — NOT unmeasurable and NOT corrupt. The
 * creator uploaded something real; Mercaria declined to open it, and the row says
 * so in a way a later, bigger processor version can revisit.
 */
export const MAX_INSPECTED_FILE_BYTES = 256 * MIB;

/**
 * The largest JSON document parsed — 32 MiB, for a `.gltf` and a GLB JSON chunk.
 *
 * `JSON.parse` materializes the whole object graph, so the real cost is several
 * times the byte count; 32 MiB of glTF JSON is already an enormous scene
 * description (the geometry lives in buffers this pipeline deliberately does not
 * read) and a document above it is far likelier to be an amplification attempt
 * than a model. Below {@link MAX_INSPECTED_FILE_BYTES} on purpose: the file
 * ceiling bounds what we read, this one bounds what we PARSE, and the two are
 * different costs.
 */
export const MAX_JSON_DOCUMENT_BYTES = 32 * MIB;

/**
 * The largest text document decoded to a string — 64 MiB, for OBJ, ASCII STL and
 * a 3MF model part.
 *
 * A UTF-8 decode of N bytes costs up to 2N in a JS string, so 64 MiB of input is
 * ~128 MiB resident. Larger than the JSON ceiling because these three formats are
 * line-oriented and their size IS the geometry — a 64 MiB OBJ is an ordinary
 * high-poly mesh, where a 64 MiB glTF JSON is not an ordinary anything.
 */
export const MAX_TEXT_DOCUMENT_BYTES = 64 * MIB;

/**
 * How many entries a container may declare — 2048.
 *
 * The zip central directory is attacker-written, so the entry COUNT is an
 * allocation instruction: a header claiming four million entries costs four
 * million objects before a single byte is inflated. 2048 is generous for the real
 * population (a 3MF is ~4 parts; a creator's texture archive is tens) and cheap
 * to refuse.
 */
export const MAX_CONTAINER_ENTRIES = 2048;

/**
 * The total expanded size of a container the pipeline will account for — 512 MiB.
 *
 * The zip-bomb ceiling (#1015 W12 threat 6). It is checked against the DECLARED
 * uncompressed sizes in the central directory, before anything is inflated, so a
 * bomb is refused by reading its own advertisement rather than by surviving it.
 */
export const MAX_CONTAINER_TOTAL_EXPANDED_BYTES = 512 * MIB;

/**
 * The largest single container entry the pipeline will inflate — 64 MiB.
 *
 * Exactly one part is ever inflated (a 3MF's `3D/3dmodel.model`), and this is its
 * ceiling. It is passed to `zlib.inflateRawSync` as `maxOutputLength`, which
 * throws `ERR_BUFFER_TOO_LARGE` rather than allocating — verified to hold under
 * BOTH runtimes this repo uses, Bun for tests and Node for production, because a
 * ceiling honoured in only one of them is not a ceiling.
 */
export const MAX_CONTAINER_ENTRY_EXPANDED_BYTES = 64 * MIB;

/**
 * The largest declared expansion ratio a container entry may claim — 200:1.
 *
 * The second half of the bomb defence, and the one that catches a TRUTHFUL bomb
 * small enough to pass the absolute ceilings: 40 KiB of zeros expanding to 40 MiB
 * is legal DEFLATE (the format reaches ~1032:1) and is never a 3D part. Real
 * model XML and real textures compress between 2:1 and 20:1, so 200 leaves an
 * order of magnitude of headroom over anything legitimate.
 */
export const MAX_CONTAINER_EXPANSION_RATIO = 200;

/**
 * How deep container nesting may go — 1. A container inside a container is never
 * opened.
 *
 * The simplest total defence against nesting amplification (#1015 W12 threat 6):
 * there is no recursion to bound because there is no recursion. A zip whose
 * members are zips is inventoried and its members are left closed, which costs
 * Mercaria nothing it wants — a creator's deliverable is files, and an archive of
 * archives is not a 3D format in {@link ASSET_FORMAT_REGISTRY}.
 */
export const MAX_CONTAINER_DEPTH = 1;

/** The longest container entry path accepted — 512 bytes. A longer one is refused unread. */
export const MAX_CONTAINER_PATH_BYTES = 512;

/**
 * The most path segments a container entry may have — 32.
 *
 * A deep path is not dangerous by itself; an unbounded one is, because every
 * normalizer that walks segments is a loop over attacker-chosen length.
 */
export const MAX_CONTAINER_PATH_SEGMENTS = 32;

/**
 * The largest triangle total the pipeline will REPORT — 20 million.
 *
 * Reachable only from a declared count (a glTF accessor), never from bytes: the
 * file ceiling caps a binary STL at ~5.4 M triangles by arithmetic. So this is
 * the bound on a CLAIM the pipeline cannot corroborate, and exceeding it is
 * `refused_too_large` rather than `measured` — the honest reading of "the file
 * says 900 million and we did not verify it".
 */
export const MAX_REPORTED_TRIANGLES = 20_000_000;

/** The same bound for vertices. Three per triangle is the worst real ratio. */
export const MAX_REPORTED_VERTICES = 60_000_000;

/**
 * The largest mesh the watertightness check runs on — 1 million triangles.
 *
 * The check is an edge census: ~3 entries per triangle in a hash map, each a
 * string key and a small record, so a million triangles is already hundreds of MB
 * of working set. Above it the answer is `watertight: null` — NOT `false`. That
 * distinction is the whole of #1015 W4's closing rule: a model we declined to
 * check must never be rendered as "not printable", and a `false` here would be
 * read as exactly that.
 */
export const MAX_WATERTIGHT_TRIANGLES = 1_000_000;

/**
 * The largest mesh unique vertex positions are counted on — 2 million triangles.
 *
 * Above it `vertexCount` is NULL rather than `3 × triangles`. The substitution
 * would be a DIFFERENT fact under the same name: a binary STL stores three
 * unshared corners per facet, so `3 × triangles` is a count of stored corners,
 * and every viewer reports the welded figure. One of the two is what a buyer
 * compares against a competitor's listing, and publishing whichever was cheaper
 * to compute is how the number stops meaning anything.
 */
export const MAX_DEDUPLICATED_VERTEX_TRIANGLES = 2_000_000;

/**
 * How many glTF nodes the scene walk may visit — 100 000, with
 * {@link MAX_GLTF_NODE_DEPTH} as the depth bound.
 *
 * A glTF node hierarchy is indices into an array, so it can declare a CYCLE, and
 * a parent/child pair pointing at each other is a two-line file that hangs a
 * recursive walker forever. Both bounds are present because either alone is
 * insufficient: a shallow cycle defeats the depth bound and a wide fan-out
 * defeats the visit bound.
 */
export const MAX_GLTF_NODE_VISITS = 100_000;

/** The deepest glTF node chain walked. See {@link MAX_GLTF_NODE_VISITS}. */
export const MAX_GLTF_NODE_DEPTH = 64;

/**
 * How many chunks a GLB container may declare — 16.
 *
 * The spec defines two (JSON, BIN) and reserves the rest for extensions. The
 * chunk table is a length-prefixed walk over attacker bytes, so it needs a bound
 * that is not "until the length runs out".
 */
export const MAX_GLB_CHUNKS = 16;

/**
 * How many distinct missing resources are reported — 64.
 *
 * The count column is unbounded; what this bounds is the NAMES, which reach the
 * creator's screen through `failure_detail`. A file referencing ten thousand
 * absent textures is one problem, not ten thousand, and a `failure_detail` the
 * size of the file it describes is a denial of service against the dashboard.
 */
export const MAX_REPORTED_MISSING_RESOURCES = 64;

/**
 * How many external resource references a text format may declare — 1024.
 *
 * OBJ's `mtllib` and glTF's `uri` fields are unbounded lists in the input. Past
 * this the reference set is truncated and the file is reported on what was read,
 * because the alternative is a set whose size is the attacker's choice.
 */
export const MAX_RESOURCE_REFERENCES = 1024;

/**
 * The largest bounding-box extent expressible, in millimetres — 100 000 000
 * (100 km).
 *
 * `asset_file_inspections.bounding_box_*_mm` is `integer`, so a value above
 * 2 147 483 647 does not fail a CHECK — it fails the INSERT, and a job that
 * cannot insert its result is a job that retries until the attempts run out with
 * nothing recorded. This ceiling keeps the refusal in the domain: an extent above
 * it leaves the bounding box NULL (not measured, which is true — it could not be
 * expressed) while the counts are still reported. 100 km is two orders of
 * magnitude below the column's limit and four above anything a creator sells.
 */
export const MAX_BOUNDING_BOX_MM = 100_000_000;

/**
 * The wall-clock budget for ONE file — 20 seconds.
 *
 * Cooperative, not preemptive: every unbounded loop in this directory checks the
 * budget at a stride of {@link DEADLINE_CHECK_STRIDE} iterations, which is what
 * makes a pathological-but-legal input a `refused_too_large` instead of a pinned
 * core. It is deliberately seconds rather than minutes because the producers fall
 * back to running the handler INLINE when Redis is absent, and that path holds an
 * HTTP request — 20 seconds is survivable there, five minutes is not.
 */
export const INSPECTION_TIME_BUDGET_MS = 20_000;

/**
 * Iterations between clock reads in a bounded loop — 65 536.
 *
 * `Date.now()` per triangle would cost more than the triangle. The stride is a
 * power of two so the check is a mask, and small enough that the overrun past the
 * deadline is bounded by the cost of 65 536 of the cheapest possible iterations.
 */
export const DEADLINE_CHECK_STRIDE = 65_536;
