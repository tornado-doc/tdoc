#!/bin/sh
# Build the upload files for the plugin directories into dist/plugins/.
#   sh plugins/pack.sh
# Each archive has the plugin's manifest at its root (no wrapping folder):
#   tdoc-claude.zip   claude.ai Customize > Plugins > Upload, or Claude Code --plugin-dir
#   tdoc-codex.zip    OpenAI plugin portal (platform.openai.com/plugins) > Upload plugin
#   tdoc-cursor.zip   local test copy for ~/.cursor/plugins/local (Cursor review takes a repo, not a zip)
#   tdoc-gemini.tar.gz  Gemini CLI GitHub-release asset (gemini-extension.json at the root)
# Plus logo-400.png (Cline marketplace asks for a 400x400 PNG) and SHA256SUMS.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
out="$root/dist/plugins"
rm -rf "$out"
mkdir -p "$out"

zipdir() { # zipdir <plugin folder> <archive name>
  (cd "$here/$1" && find . -type f ! -name '.DS_Store' | LC_ALL=C sort | sed 's|^\./||' \
    | zip -q -X "$out/$2" -@)
}
zipdir claude tdoc-claude.zip
zipdir codex tdoc-codex.zip
zipdir cursor tdoc-cursor.zip
(cd "$here/gemini" && COPYFILE_DISABLE=1 tar -czf "$out/tdoc-gemini.tar.gz" gemini-extension.json GEMINI.md skills)

if command -v sips >/dev/null 2>&1; then
  sips -z 400 400 "$here/claude/assets/logo.png" --out "$out/logo-400.png" >/dev/null
elif command -v convert >/dev/null 2>&1; then
  convert "$here/claude/assets/logo.png" -resize 400x400 "$out/logo-400.png"
else
  echo "note: no sips or ImageMagick; make logo-400.png by hand" >&2
fi

(cd "$out" && shasum -a 256 * > SHA256SUMS)
ls -l "$out"
