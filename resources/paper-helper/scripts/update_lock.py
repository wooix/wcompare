"""Record a new approved revision of the reusable UI assets."""
import argparse
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--version", required=True)
args = parser.parse_args()
files = {
    path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
    for path in sorted((root / "assets/site").rglob("*")) if path.is_file()
}
payload = {"version": args.version, "files": files}
(root / "template-lock.json").write_text(json.dumps(payload, indent=2) + "\n")
print(json.dumps({"version": args.version, "assets": len(files)}))
