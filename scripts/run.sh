#!/usr/bin/env bash
#
# Purpose: Detect available JS runtime, set runner variables, and resolve tool binaries
#
# This module:
# - Exports RUNNER (runtime binary) and RUNX (npx equivalent)
# - Exports resolve_tool() to locate a binary via PATH, node_modules/.bin, or nix fallback
# - Prefers bun, falls back to node/npx

if command -v bun &>/dev/null; then
	export RUNNER=bun
	export RUNX="bunx"
else
	export RUNNER=node
	export RUNX="npx"
fi

# Resolve a tool binary: PATH first, then node_modules/.bin, then nix fallback.
# Each candidate is verified with --version so broken wrappers (e.g. dynamically
# linked biome binaries on NixOS/non-FHS systems) are skipped.
resolve_tool() {
	local name="$1"
	local bin="${2:-$1}"
	local candidate

	if command -v "$name" &>/dev/null; then
		candidate=$(command -v "$name")
		if "$candidate" --version &>/dev/null; then
			echo "$candidate"
			return 0
		fi
	fi

	if [[ -x "./node_modules/.bin/$bin" ]]; then
		candidate="./node_modules/.bin/$bin"
		if "$candidate" --version &>/dev/null; then
			echo "$candidate"
			return 0
		fi
	fi

	if command -v nix &>/dev/null; then
		echo "nix run nixpkgs#$bin --"
		return 0
	fi
	echo "ERROR:$name" >&2
	return 1
}
