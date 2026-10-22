#!/bin/sh
set -eu
script_directory=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec node "$script_directory/install.mjs" "$@"
