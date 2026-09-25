#!/usr/bin/env python3
"""Developer benchmark: fixed HTML, real CLIs, loopback uploads, no account needed.

Example: python3 test/benchmark-browser-removal.py --baseline /old/checkout
  --candidate /new/checkout --output /tmp/tdoc-benchmark --repeats 5
Baseline needs its locked Playwright dependency and Chromium installed.
The candidate is copied without node_modules. No package installation is run.
Peak RSS is sampled process-tree aggregate RSS (includes shared pages), not
physical RAM or a low-memory-machine simulation. Browser startup is included;
package/browser download and model generation/repair time are excluded.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import tempfile
import threading
import time


def sha(data):
    return hashlib.sha256(data).hexdigest()


def measure(command, cwd, env):
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        start = time.perf_counter()
        proc = subprocess.Popen(command, cwd=cwd, env=env, stdout=out, stderr=err, start_new_session=True)
        peak_kib, browser_seen, samples = 0, False, 0
        tracked = {proc.pid}
        peak_processes = []
        while proc.poll() is None:
            rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,pgid=,rss=,comm='], text=True)
            processes = []
            for line in rows.splitlines():
                fields = line.strip().split(None, 4)
                if len(fields) == 5:
                    processes.append((int(fields[0]), int(fields[1]), int(fields[2]), int(fields[3]), fields[4]))
            # Playwright detaches Chromium into its own process group. Follow
            # descendants as well, otherwise browser memory disappears here.
            for _ in range(len(processes)):
                found = {pid for pid, ppid, pgid, _, _ in processes if ppid in tracked or pgid == proc.pid}
                if found <= tracked: break
                tracked.update(found)
            members = [(pid, rss, name) for pid, _, _, rss, name in processes if pid in tracked]
            rss = sum(member[1] for member in members)
            browser_seen |= any(any(s in name.lower() for s in ['chrome', 'chromium', 'headless_shell']) for _, _, name in members)
            if rss > peak_kib:
                peak_kib = rss
                peak_processes = [dict(pid=pid, rss_kib=rss, name=name) for pid, rss, name in members]
            samples += 1
            if time.perf_counter() - start > 90:
                os.killpg(proc.pid, 9)
                raise RuntimeError(f'command timed out: {command}')
            time.sleep(.01)
        elapsed = time.perf_counter() - start
        out.seek(0); err.seek(0)
        return dict(exit_code=proc.returncode, seconds=elapsed, peak_aggregate_rss_mib=peak_kib / 1024,
                    browser_process_seen=browser_seen, samples=samples, peak_processes=peak_processes,
                    stdout=out.read().decode(), stderr=err.read().decode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repeats', type=int, default=5)
    args = parser.parse_args()
    baseline, candidate, output = args.baseline.resolve(), args.candidate.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    pw_cache = subprocess.check_output(['node', '-e', "const p=require('path');console.log(p.resolve(require('playwright').chromium.executablePath().split(/chromium-\\d+/)[0]))"], cwd=baseline, text=True).strip()
    received = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            received.append(payload)
            data = json.dumps(dict(ok=True, slug=payload['slug'], version=payload['version'], size=len(payload['html']))).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(data)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    header = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:white}</style></head><body><div class="wrap">'
    footer = '</div></body></html>'
    cases = {
        'prose': (header + '<h1>Release notes</h1>' + '<h2>What changed</h2><p>Documents keep their reading template, version history, and comments when edited and published.</p>' * 10 + footer, []),
        'table': (header + '<h1>Plan comparison</h1><div class="tdoc-table-scroll"><table><tr><th>Plan</th><th>Storage</th><th>Price</th></tr>' + ''.join(f'<tr><td>Team {i}</td><td data-tdoc-cell="value">{i*10} GB</td><td data-tdoc-cell="value">${i*8}/month</td></tr>' for i in range(1, 9)) + '</table></div>' + footer, []),
        'svg': (header + '<h1>Document workflow</h1><svg viewBox="0 0 600 120" style="width:100%;height:auto" aria-label="Workflow"><rect x="10" y="10" width="230" height="90" fill="#eee"/><text x="30" y="65" font-size="24">Create document</text><path d="M250 55H340" stroke="black"/><rect x="350" y="10" width="240" height="90" fill="#eee"/><text x="375" y="65" font-size="24">Publish document</text></svg>' + footer, []),
        'raft-regression': ((baseline / 'test/fixtures/raft-layout-regression.html').read_text(), []),
        'raft-full': ((baseline / 'test/fixtures/raft-layout-full.html').read_text(), ['--custom-template']),
        'invalid-template': (header + '<h1>Invalid footer</h1><footer>Forbidden template element</footer>' + footer, []),
    }
    records = []
    with tempfile.TemporaryDirectory(prefix='tdoc-bench-') as scratch:
        clean = Path(scratch) / 'candidate'
        shutil.copytree(candidate, clean, ignore=shutil.ignore_patterns('.git', 'node_modules', '__pycache__'))
        assert not (clean / 'node_modules').exists()
        for case, (html, flags) in cases.items():
            folder = output / case; folder.mkdir(exist_ok=True)
            source = folder / 'input.html'; source.write_text(html)
            for trial in range(-1, args.repeats):  # warmup excluded
                variants = [('before', baseline), ('after', clean)]
                if trial % 2: variants.reverse()
                for label, checkout in variants:
                    home = Path(scratch) / f'{case}-{trial}-{label}'; home.mkdir()
                    config = home / '.tdoc/published.json'; config.parent.mkdir()
                    config.write_text(json.dumps(dict(platform='hosted', base=f'http://127.0.0.1:{server.server_port}', public_host='127.0.0.1', upload_token='benchmark-local-only')))
                    env = {**os.environ, 'HOME': str(home), 'SKILL_DIR': str(checkout), 'TDOC_DIR': str(home / 'docs'),
                           'TDOC_CONFIG_FILE': str(config), 'TDOC_PLATFORM': 'hosted', 'TDOC_SKIP_UPDATE_CHECK': '1',
                           'TDOC_MOCK_UPDATE_BEHIND': '0', 'PLAYWRIGHT_BROWSERS_PATH': pw_cache if label == 'before' else str(home / 'no-browser'),
                           'NODE_PATH': '', 'NODE_OPTIONS': '', 'TDOC_LAYOUT_REQUIRE': '1'}
                    create = measure(['bash', str(checkout / 'bin/tdoc-write'), '--slug', case, '--title', case,
                                      '--html-file', str(source), '--quiet', '--no-server', *flags], checkout, env)
                    if label == 'before' and create['exit_code'] == 0 and not create['browser_process_seen']:
                        raise RuntimeError('Baseline browser was not observed; memory sampling is invalid')
                    record = dict(case=case, variant=label, trial=trial, create=create)
                    target = home / 'docs' / case / 'v1/index.html'
                    if create['exit_code'] == 0:
                        saved = target.read_bytes(); record['html_sha256'] = sha(saved)
                        if trial == 0: (folder / f'{label}.html').write_bytes(saved)
                        received.clear()
                        publish = measure(['bash', str(checkout / 'bin/tdoc-publish'), '--visibility', 'private', '--history', 'owner', case], checkout, env)
                        record['publish'] = publish
                        record['uploaded_exact_saved_html'] = bool(received) and all(p['html'].encode() == saved for p in received)
                    if trial >= 0: records.append(record)
                if trial >= 0: print(f'{case}: trial {trial + 1}/{args.repeats}', flush=True)
    server.shutdown(); server.server_close()
    summary = []
    for case in cases:
        row = dict(case=case)
        hashes = {}
        for variant in ['before', 'after']:
            group = [r for r in records if r['case'] == case and r['variant'] == variant]
            hashes[variant] = sorted(set(r['html_sha256'] for r in group if 'html_sha256' in r))
            row[variant] = dict(created=sum(r['create']['exit_code'] == 0 for r in group), repeats=args.repeats,
                                html_hashes=hashes[variant])
            for action in ['create', 'publish']:
                measurements = [r[action] for r in group if action in r]
                if measurements:
                    row[variant][action] = dict(median_seconds=statistics.median(m['seconds'] for m in measurements),
                        median_peak_rss_mib=statistics.median(m['peak_aggregate_rss_mib'] for m in measurements),
                        any_browser_process=any(m['browser_process_seen'] for m in measurements),
                        successes=sum(m['exit_code'] == 0 for m in measurements))
        row['identical_html'] = bool(hashes['before']) and hashes['before'] == hashes['after']
        summary.append(row)
    result = dict(baseline_sha=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=baseline, text=True).strip(),
                  platform=platform.platform(), node=subprocess.check_output(['node', '--version'], text=True).strip(),
                  repeats=args.repeats, methodology=__doc__, summary=summary, records=records)
    (output / 'results.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
