.PHONY: dev build test lint typecheck format integration
dev build test lint typecheck format:
	npm run $@
integration:
	npm run test:integration
