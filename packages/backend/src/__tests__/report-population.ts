/**
 * Print a population on SUCCESS — and NOT through `console.*`.
 *
 * This epic has adopted "print the population size on success" as a convention,
 * because a census that measured nothing and a census that found nothing produce
 * the same green tick. The number is the thing that tells them apart, so it has
 * to be legible in the run it was written for.
 *
 * **Measured, because it is exactly the kind of thing that reads as done and is
 * not:** vitest 4's default reporter — which `bun run test` and CI both use —
 * suppresses `console.info` / `console.log` / `console.error` from a test that
 * PASSED, and shows them only under `--reporter=verbose`. A direct write to the
 * stream survives both.
 *
 * The A/B, run on `matcher-displacement.test.ts` (#612 part C):
 *
 * ```
 * default reporter  -> 0 occurrences of the census line
 * --reporter=verbose -> 1 occurrence
 * ```
 *
 * So a population printed with `console.log` is a number nobody reading a CI log
 * ever sees, which is the same as not printing it — and it fails in the one
 * direction nobody checks, because the test is green either way.
 *
 * Note the asymmetry that makes this easy to miss: console output IS shown for a
 * test that FAILED. So the line is visible in every run where it does not matter
 * and invisible in every run where it does.
 */
export function reportPopulation(line: string): void {
  process.stdout.write(`${line}\n`);
}
