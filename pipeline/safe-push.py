#!/usr/bin/env python3
"""Commit + push the data files with content-aware merging.

Two workflow runs often edit sources.json / taps.json concurrently, and
git's text rebase can't merge JSON (this lost the Portland ME scan).
Instead: union by key — our working-tree entries win per-key, entries
that only exist upstream are kept — then reset to origin/main, write the
merged files, commit, push. Re-merges and retries if the push races.

Usage: safe-push.py "commit message"
"""
import json
import subprocess
import sys
import time

MSG = sys.argv[1]
FILES = [
    'pipeline/sources.json',
    'pipeline/areas.json',
    'pipeline/extra-breweries.json',
    'data/taps.json',
]


def sh(*a):
    return subprocess.run(a, text=True, capture_output=True)


ours = {}
for f in FILES:
    try:
        ours[f] = json.load(open(f))
    except FileNotFoundError:
        pass

for attempt in range(4):
    sh('git', 'fetch', 'origin', 'main')
    theirs = {}
    for f in FILES:
        r = sh('git', 'show', f'origin/main:{f}')
        if r.returncode == 0:
            theirs[f] = json.loads(r.stdout)

    merged = dict(theirs)
    if 'pipeline/sources.json' in ours:
        by = {e['obdb_id']: e for e in theirs.get('pipeline/sources.json', [])}
        by.update({e['obdb_id']: e for e in ours['pipeline/sources.json']})
        merged['pipeline/sources.json'] = list(by.values())
    if 'pipeline/areas.json' in ours:
        by = {a['center']: a for a in theirs.get('pipeline/areas.json', [])}
        by.update({a['center']: a for a in ours['pipeline/areas.json']})
        merged['pipeline/areas.json'] = list(by.values())
    if 'pipeline/extra-breweries.json' in ours:
        by = {e['id']: e for e in theirs.get('pipeline/extra-breweries.json', [])}
        by.update({e['id']: e for e in ours['pipeline/extra-breweries.json']})
        merged['pipeline/extra-breweries.json'] = list(by.values())
    if 'data/taps.json' in ours:
        o = ours['data/taps.json']
        t = theirs.get('data/taps.json', {})
        brew = dict(t.get('breweries', {}))
        brew.update(o.get('breweries', {}))
        areas = merged.get('pipeline/areas.json') or o.get('areas') or []
        extras = (merged.get('pipeline/extra-breweries.json')
                  or o.get('extra_breweries')
                  or t.get('extra_breweries')
                  or [])
        merged['data/taps.json'] = {
            'generated_at': max(o.get('generated_at') or '', t.get('generated_at') or '') or None,
            'areas': [{'label': a['label'], 'center': a['center']} for a in areas],
            'extra_breweries': extras,
            'breweries': brew,
        }

    sh('git', 'rebase', '--abort')  # clear any earlier mess
    sh('git', 'reset', '--hard', 'origin/main')
    for f, v in merged.items():
        with open(f, 'w') as fh:
            json.dump(v, fh, indent=2)
            fh.write('\n')
    sh('git', 'add', *FILES)
    if sh('git', 'diff', '--cached', '--quiet').returncode == 0:
        print('nothing to commit')
        sys.exit(0)
    sh('git', 'commit', '-m', MSG)
    r = sh('git', 'push', 'origin', 'main')
    if r.returncode == 0:
        print('pushed')
        sys.exit(0)
    print(f'push rejected (attempt {attempt + 1}) — re-merging')
    time.sleep(5)

sys.exit(1)
