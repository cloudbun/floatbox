◊package main

import (
	"encoding/json"
	"syscall/js"

	"uar/pkg/engine"
	"uar/pkg/parser"
	"uar/pkg/schema"
)

// NOTE: Each Web Worker loads its own WASM instance. Global state is NOT shared
// across workers. The SoT worker uses globalSoTIndex locally only. Satellite
// workers receive the SoT index via loadSoTIndex() — they never call parseSoT().

var globalSoTIndex *engine.SoTIndex

// parseSoT handles the uarParseSoT JS function call.
// args[0] = Uint8Array (CSV bytes)
// args[1] = string (column map JSON)
// Returns: JSON string with two top-level keys: "stats" and "serializedIndex"
func parseSoT(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		errJSON, _ := json.Marshal(map[string]string{"error": "parseSoT requires 2 arguments: Uint8Array and columnMapJSON"})
		return string(errJSON)
	}

	csvBytes := make([]byte, args[0].Get("length").Int())
	js.CopyBytesToGo(csvBytes, args[0])

	columnMapJSON := args[1].String()

	records, err := parser.StreamParse(csvBytes)
	if err != nil {
		errJSON, _ := json.Marshal(map[string]string{"error": err.Error()})
		return string(errJSON)
	}

	mapped := schema.NormalizeSoT(records, columnMapJSON)
	globalSoTIndex = engine.BuildSoTIndex(mapped)

	// Serialize the full index so the main thread can broadcast it to satellite workers.
	// This is the ONLY way satellite workers get the SoT index — they run in separate
	// WASM instances with no shared memory.
	result := map[string]interface{}{
		"stats":           globalSoTIndex.Stats,
		"serializedIndex": engine.SerializeSoTIndex(globalSoTIndex),
	}
	resultJSON, _ := json.Marshal(result)
	return string(resultJSON)
}

// loadSoTIndex handles the uarLoadSoTIndex JS function call.
// Called in satellite workers BEFORE parseSatellite.
// args[0] = string (serialized SoT index JSON from parseSoT output)
// Deserializes the SoT index into this WASM instance's global memory.
func loadSoTIndex(this js.Value, args []js.Value) interface{} {
	if len(args) < 1 {
		errJSON, _ := json.Marshal(map[string]string{"error": "loadSoTIndex requires 1 argument: serialized index JSON"})
		return string(errJSON)
	}

	indexJSON := args[0].String()
	var err error
	globalSoTIndex, err = engine.DeserializeSoTIndex([]byte(indexJSON))
	if err != nil {
		errJSON, _ := json.Marshal(map[string]string{"error": err.Error()})
		return string(errJSON)
	}
	return `{"ok": true}`
}

// parseSatellite handles the uarParseSatellite JS function call.
// args[0] = Uint8Array (CSV bytes)
// args[1] = string (system name)
// args[2] = string (column map JSON)
// PRECONDITION: loadSoTIndex() must have been called first in this worker.
func parseSatellite(this js.Value, args []js.Value) interface{} {
	if globalSoTIndex == nil {
		errJSON, _ := json.Marshal(map[string]string{"error": "SoT index not loaded — call loadSoTIndex() first"})
		return string(errJSON)
	}

	if len(args) < 3 {
		errJSON, _ := json.Marshal(map[string]string{"error": "parseSatellite requires 3 arguments: Uint8Array, systemName, and columnMapJSON"})
		return string(errJSON)
	}

	csvBytes := make([]byte, args[0].Get("length").Int())
	js.CopyBytesToGo(csvBytes, args[0])

	systemName := args[1].String()
	columnMapJSON := args[2].String()

	records, err := parser.StreamParse(csvBytes)
	if err != nil {
		errJSON, _ := json.Marshal(map[string]string{"error": err.Error()})
		return string(errJSON)
	}

	mapped := schema.NormalizeSatellite(records, systemName, columnMapJSON)
	result := engine.JoinAgainstSoT(globalSoTIndex, mapped, systemName)

	resultJSON, _ := json.Marshal(result)
	return string(resultJSON)
}

func main() {
	js.Global().Set("uarParseSoT", js.FuncOf(parseSoT))
	js.Global().Set("uarLoadSoTIndex", js.FuncOf(loadSoTIndex))
	js.Global().Set("uarParseSatellite", js.FuncOf(parseSatellite))

	// Block forever — WASM module stays alive
	select {}
}
