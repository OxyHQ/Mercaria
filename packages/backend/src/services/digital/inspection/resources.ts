/**
 * Resolving the resources a model NAMES against the files a version CONTAINS
 * (#1015 W4 requirement 3).
 *
 * An OBJ naming an MTL, a glTF naming a texture or an external `.bin` — the
 * reference is a string an uploader wrote, and there are exactly two things this
 * module may do with it: match it against a set of names already in hand, or
 * report it absent. What it may never do is RESOLVE it, and the refusals below are
 * the shape of that rule:
 *
 * - **A remote URI is always missing.** `http://…`, `https://…`, `file://…` and
 *   every other scheme. The pipeline does not fetch, so a model naming a URL is a
 *   model whose texture is not in the package — and a worker that followed one
 *   would be a server-side request forgery primitive driven by an anonymous
 *   upload (#1015 W12 threat 7), pointed wherever the attacker likes, inside
 *   Mercaria's network.
 * - **An absolute path is always missing.** `/etc/passwd` and `C:\keys\id_rsa`
 *   are not textures; the only reason to write one is to find out whether
 *   Mercaria opens it.
 * - **A path escaping its own root is always missing.** `../../secrets/x.png`
 *   (#1015 W12 threat 6). Checked on the NORMALIZED segments, so `a/../../b` is
 *   caught as well as a bare `..`.
 *
 * In all three the answer is "absent", never an error: the creator's screen should
 * say which texture is missing, and a traversal attempt and a typo are the same
 * fact from the package's point of view. The REASON travels alongside so an
 * operator can tell them apart.
 *
 * ## Matching is by base name, case-insensitively
 *
 * A version holds `asset_files.file_name`, which is a name and not a path, while a
 * reference inside a model is whatever the creator's exporter wrote — often
 * `textures/diffuse.png` from a directory layout that does not survive the upload.
 * Comparing base names is therefore the only comparison that can succeed at all,
 * and case-insensitivity is for the creator on Windows whose exporter wrote
 * `Diffuse.PNG` for a file they uploaded as `diffuse.png`.
 *
 * The cost is that two files of the same base name in different directories are
 * indistinguishable here. That is the right trade while `asset_files` stores a flat
 * name: the alternative reports a missing texture for a package that contains it,
 * which is a false accusation against the creator rather than a missed one.
 */

/** How long a reference may be when it reaches a creator's screen. */
const MAX_REPORTED_REFERENCE_CHARS = 120;

/** Why a reference could not be matched. Absent when it was. */
export type MissingResourceReason =
  | 'remote_uri'
  | 'absolute_path'
  | 'escapes_package'
  | 'not_in_version';

/** One reference, resolved. */
export interface ResourceResolution {
  /** The reference as written, trimmed and bounded for display. */
  readonly reference: string;
  readonly present: boolean;
  readonly reason?: MissingResourceReason;
}

/** The comparison key for a file name: its base name, lowercased. */
export function resourceMatchKey(name: string): string {
  const withoutQuery = name.split(/[?#]/u)[0] ?? name;
  const segments = withoutQuery.split(/[/\\]/u);
  const base = segments[segments.length - 1] ?? '';
  return base.trim().toLowerCase();
}

/** The set a version's file names form, ready for {@link resolveResourceReference}. */
export function resourceIndexOf(fileNames: readonly string[]): ReadonlySet<string> {
  return new Set(fileNames.map((name) => resourceMatchKey(name)).filter((key) => key !== ''));
}

/**
 * Whether `raw` names something the version contains.
 *
 * `decodeUri` is for glTF, whose `uri` fields are percent-encoded by spec, and is
 * off for OBJ, whose `mtllib` is a bare file name and where a literal `%20` is a
 * literal `%20`. Decoding where the format does not ask for it would turn one
 * creator's oddly-named file into a reference that matches nothing.
 */
export function resolveResourceReference(
  raw: string,
  available: ReadonlySet<string>,
  options?: { readonly decodeUri?: boolean },
): ResourceResolution | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // A data URI carries its own bytes. Nothing is referenced, so nothing can be
  // missing — and it is checked BEFORE the scheme test below, which would
  // otherwise report every embedded texture in every glTF as a remote fetch.
  if (/^data:/iu.test(trimmed)) return null;

  const reference = display(trimmed);

  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    return { reference, present: false, reason: 'remote_uri' };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-z]:[/\\]/iu.test(trimmed)) {
    return { reference, present: false, reason: 'absolute_path' };
  }

  let candidate = trimmed;
  if (options?.decodeUri) {
    try {
      candidate = decodeURIComponent(trimmed);
    } catch {
      // A malformed percent escape. Not decodable, so not matchable — and not an
      // error either: the file names something no package can hold.
      return { reference, present: false, reason: 'not_in_version' };
    }
  }

  if (escapesRoot(candidate)) {
    return { reference, present: false, reason: 'escapes_package' };
  }

  const key = resourceMatchKey(candidate);
  if (key === '') return { reference, present: false, reason: 'not_in_version' };
  if (available.has(key)) return { reference, present: true };
  return { reference, present: false, reason: 'not_in_version' };
}

/**
 * Whether a relative path leaves its own root.
 *
 * Walks the segments and tracks depth rather than searching for the string `..`,
 * so `a/../../b` is caught (depth goes negative) while `a/../b` — which stays
 * inside — is not reported as an escape. A substring test would flag both, and a
 * creator whose exporter emitted a harmless `./` chain would be told their package
 * is broken.
 */
function escapesRoot(path: string): boolean {
  let depth = 0;
  for (const segment of path.split(/[/\\]/u)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) return true;
      continue;
    }
    depth += 1;
  }
  return false;
}

/** A reference, bounded for display. */
function display(reference: string): string {
  if (reference.length <= MAX_REPORTED_REFERENCE_CHARS) return reference;
  return `${reference.slice(0, MAX_REPORTED_REFERENCE_CHARS)}…`;
}
