/**
 * Writes `docs/catalog-architecture-diagrams.md` from the derived model.
 *
 * The only thing in this workstream that touches the filesystem for writing.
 * The gate beside it calls the SAME `renderDocument` and byte-compares, so this
 * script is not a second implementation — running it is how you make the file
 * agree with the schema, and the build is what notices when you have not.
 *
 *     bun run --cwd packages/backend architecture:diagrams
 */

import { writeFileSync } from 'node:fs';
import { DIAGRAM_DOC, buildModel } from './architecture/model.js';
import { renderDocument } from './architecture/render.js';

const rendered = renderDocument(buildModel());
writeFileSync(DIAGRAM_DOC, rendered, 'utf8');
process.stdout.write(`wrote ${DIAGRAM_DOC} (${rendered.split('\n').length} lines)\n`);
