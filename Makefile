.PHONY: world deps demo dev test audit ask evals-live apollo-check publish-sample google-auth
deps: ; @[ -d node_modules ] || npm ci
demo: deps ; npm run demo
dev: deps ; npm run dev
test: deps ; npm test && npm run typecheck
audit: deps ; npm run audit
ask: deps ; node scripts/ask.ts "$(Q)"
evals-live: deps ; node scripts/record-evals.ts
apollo-check: deps ; node scripts/apollo-check.ts "$(COMPANY)" "$(MATCHES)"
publish-sample: deps ; node --env-file-if-exists=.env scripts/publish-sample.ts $(ARGS)
google-auth: deps ; node --env-file-if-exists=.env scripts/google-auth.ts --out "$(OUT)"
world: deps ; node scripts/gen-world.ts
