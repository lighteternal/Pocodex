"""A stand-in Claude Code CLI for the usage-check desktop test: a background session showing /usage.

Every call is recorded in calls.jsonl in the working directory, so the test can check the guards and
that the session is removed.
"""

import json
import sys
from pathlib import Path

arguments = sys.argv[1:]
with (Path.cwd() / "calls.jsonl").open("a", encoding="utf-8") as log:
    log.write(json.dumps(arguments) + "\n")
if arguments[:1] == ["--bg"]:
    sys.stdout.buffer.write("Starting background service…\nbackgrounded · f00dcafe\n".encode("utf-8"))
elif arguments[:1] == ["logs"]:
    sys.stdout.buffer.write((
        "   Current session\n   ████ 42% used\n   Resets 11:59pm (Europe/Athens)\n"
        "   Current week (all models)\n   ██████ 57% used   Resets 11:58pm (Europe/Athens)\n"
    ).encode("utf-8"))
