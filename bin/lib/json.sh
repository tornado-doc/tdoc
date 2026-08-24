# tdoc shared JSON helpers — node, not jq.
#
# Node 18+ is already a hard requirement (the local server and the worker
# bundle both run on it), so every bin script can read and write JSON without
# a second dependency. jq is a self-host-only tool now: only the Cloudflare
# and Vercel setup paths may assume it.
#
# Source this from a bin script:
#   . "$(dirname "$0")/lib/json.sh"
#
# Four PRs removed jq from one script each before this file existed (#228,
# #257, #273, #275). Add new JSON handling here rather than reaching for jq
# in the next script.

# json_get <dotted.path> — reads JSON on stdin, writes the value (no newline).
# A missing path, a null, or unparseable input all produce empty output and
# exit 0, which is what the callers' `// empty` jq filters meant.
json_get() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      let o;
      try { o = JSON.parse(s); } catch { process.exit(0); }
      const v = process.argv[1].split(".").reduce((a, k) => (a == null ? a : a[k]), o);
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    });
  ' "$1"
}

# json_file_get <file> <dotted.path> — same, from a file. Missing file is empty.
json_file_get() {
  [ -f "$1" ] || return 0
  json_get "$2" < "$1"
}

# json_str <string> — JSON-encode one string, quotes included.
json_str() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

# json_is_array — stdin parses as a JSON array? Exit status only.
json_is_array() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      try { process.exit(Array.isArray(JSON.parse(s)) ? 0 : 1); } catch { process.exit(1); }
    });
  '
}

# json_file_is_array <file>
json_file_is_array() {
  [ -f "$1" ] || return 1
  json_is_array < "$1"
}

# json_file_len <file> — element count of a JSON array file, 0 for anything else.
json_file_len() {
  [ -f "$1" ] || { printf 0; return 0; }
  node -e '
    const fs = require("fs");
    try {
      const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(Array.isArray(v) ? v.length : 0));
    } catch { process.stdout.write("0"); }
  ' "$1"
}

# json_pretty — pretty-print stdin. Invalid JSON passes through untouched so a
# worker error page still reaches the user's eyes instead of vanishing.
json_pretty() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      try { process.stdout.write(JSON.stringify(JSON.parse(s), null, 2) + "\n"); }
      catch { process.stdout.write(s); }
    });
  '
}

# json_error — stdin is a worker response; write .error if this is an object
# carrying one, and exit 0. Exit 1 when there is no error field.
json_error() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      let o;
      try { o = JSON.parse(s); } catch { process.exit(1); }
      if (o && typeof o === "object" && !Array.isArray(o) && o.error !== undefined) {
        process.stdout.write(String(o.error));
        process.exit(0);
      }
      process.exit(1);
    });
  '
}
