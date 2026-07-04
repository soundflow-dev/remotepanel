from __future__ import annotations

import sys

from app.transfers.jobs import run_transfer_job


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python -m app.transfers.worker <job_id>", file=sys.stderr)
        return 2
    try:
        job_id = int(sys.argv[1])
    except ValueError:
        print("job_id must be an integer", file=sys.stderr)
        return 2
    status = run_transfer_job(job_id, exit_on_stall=True)
    if status == "failed":
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
