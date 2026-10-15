# Vendored owning-product SDK

This unpublished tarball is built from the owning repository, without consumer
patches. `sdk-provenance.json` records its source commit and content hashes.
Runtime imports and declarations contain no private workspace dependency.

Rebuild the owning SDK at that commit, run its package build and pack/smoke
script, copy the tested tarball here, and refresh the Bun lockfile. Do not edit
the archive in this repository. Docker copies `vendor/` before installing.
