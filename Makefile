.PHONY: wasm dev build clean

wasm:
	GOOS=js GOARCH=wasm go build -o build/uar_engine.wasm ./src/go/cmd/wasm/
	cp "$$(go env GOROOT)/misc/wasm/wasm_exec.js" public/wasm_exec.js

dev: wasm
	npx vite

build: wasm
	npx vite build

clean:
	rm -rf build/ dist/ public/wasm_exec.js
