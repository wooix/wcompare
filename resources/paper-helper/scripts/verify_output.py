"""Check that a generated reader still uses the exact approved template assets."""
import argparse
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--site", type=Path, required=True)
args = parser.parse_args()
site = args.site.resolve()
lock = json.loads((root / "template-lock.json").read_text())
failures = []
for name, expected in lock["files"].items():
    path = site / name.removeprefix("assets/site/")
    if not path.is_file():
        failures.append("Missing UI asset: " + path.name)
    elif hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        failures.append("Changed UI asset: " + path.name)
report = json.loads((site / "build-report.json").read_text())
if report["templateVersion"] != lock["version"]:
    failures.append("Template version mismatch")
if report["sourceUnits"] != report["translatedUnits"] or report["missing"]:
    failures.append("Incomplete source-unit coverage")
if failures:
    raise SystemExit("\n".join(failures))
print(json.dumps({"templateVersion": lock["version"], "paperId": report["paperId"], "verifiedUiAssets": len(lock["files"]), "sourceUnits": report["sourceUnits"]}))
