"""Read-only adapter smoke check; print counts, never conversation content."""

import argparse
import json
import time
from collections import Counter
from pathlib import Path

from observatory.companion.sources import Sources


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, action='append')
    parser.add_argument('--seconds', type=int, default=30, choices=range(5, 61))
    args = parser.parse_args()
    start = time.time()
    adapter = Sources(args.source or [Path.home() / '.codex'], start)
    events = Counter()
    durations = []
    maximum_running = 0
    while time.time() - start < args.seconds:
        before = time.perf_counter()
        events.update(event['kind'] for event in adapter.poll(time.time()))
        durations.append(time.perf_counter() - before)
        maximum_running = max(maximum_running, adapter.snapshot(time.time())['running'])
        time.sleep(.5)
    snapshot = adapter.snapshot(time.time())
    print(json.dumps({'seconds': round(time.time() - start, 1), 'source_count': len(adapter.roots),
                      'files_observed': len(adapter.paths), 'events': dict(events),
                      'maximum_running': maximum_running, 'quota_snapshots': len(snapshot['quota']),
                      'recorded_responses': len(snapshot['usage']),
                      'source_status': [source['status'] for source in snapshot['sources']],
                      'max_poll_seconds': round(max(durations), 3), 'read_only': True}, indent=2))


if __name__ == '__main__':
    main()
