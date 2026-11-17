# Proposed pre-push hook (not installed)

This is a proposal. Nothing here is installed, and nothing in the repository runs it. `make docs-check` runs in about a second, needs no install and no database, and fails when the README, PROJECT-STATUS or the decisions drift from the code (`scripts/docs-check.mjs`). The suite runs the same check in `tests/docs-check.test.ts`.

To use it, save this as `.git/hooks/pre-push` and make it executable (`chmod +x .git/hooks/pre-push`):

```sh
#!/bin/sh
# Stop a push when the docs have drifted from the code.
make docs-check || {
  echo "docs-check failed: fix the docs in the same commit as the change, then push again." >&2
  exit 1
}
```

Skip it once with `git push --no-verify`.
