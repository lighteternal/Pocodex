"""Bundled sidecar entry point."""

import sys

from observatory.companion.service import main as service_main
from observatory.companion.startup import main as startup_main

if __name__ == "__main__":
    if "--startup" in sys.argv:
        sys.argv.remove("--startup")
        startup_main()
    else:
        service_main()
