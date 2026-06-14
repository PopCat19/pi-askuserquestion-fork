#!/usr/bin/env bash
#
# Purpose: Runs biome, jscpd, and knip checks (NixOS-aware)

set -Eeuo pipefail

source "$(dirname "$0")/run.sh"

BIOME=$(resolve_tool biome biome)
JSCPD=$(resolve_tool jscpd jscpd)
KNIP=$(resolve_tool knip knip)

# Run biome check (may be a nix fallback — eval needed for compound cmds)
if echo "$BIOME" | grep -q '^nix '; then
	eval "$BIOME" check --error-on-warnings src/ tests/
else
	"$BIOME" check --error-on-warnings src/ tests/
fi

# jscpd duplicate detection
if echo "$JSCPD" | grep -q '^nix '; then
	eval "$JSCPD" src/ --min-lines 8 --min-tokens 50 --reporters console
else
	"$JSCPD" src/ --min-lines 8 --min-tokens 50 --reporters console
fi

# knip dead code detection
if echo "$KNIP" | grep -q '^nix '; then
	eval "$KNIP"
else
	"$KNIP"
fi
