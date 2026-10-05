# Shared CI fixture correction

CI [37205371168](https://github.com/OxyHQ/Mercaria/actions/runs/37205371168) failed one new assertion: general Stripe reconciliation correctly visited six additional rows from other suites. The fixture had incorrectly expected whole-database counts. All 783 other backend suites passed.

The followup inserts another owned synthetic noncohort row with no upstream snapshot. The old count assertion reproduces 1 failure / 4 passes. The corrected fixture traverses bounded pages and checks only its own three eligible states/calls, the complete unchanged external failure row, and its complete unchanged wrong-mode row: 5 passes. It deletes no other suite data and does not alter runtime policy. Types and scoped lint pass. Both local PostgreSQL processes stopped.

The original proof remains historical for its exact original fixture. This supplemental proof binds the new fixture and failures; it makes no new full-CI or product runtime claim.
