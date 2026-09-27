#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
source_manifest="$root/app/src/main/AndroidManifest.xml"
merged_manifest="$root/app/build/intermediates/merged_manifests/debug/AndroidManifest.xml"

[ -f "$merged_manifest" ] || {
  printf 'merged Android manifest missing; run :app:processDebugManifest first\n' >&2
  exit 1
}

python3 - "$source_manifest" "$merged_manifest" <<'PY'
import sys
import xml.etree.ElementTree as ET

ANDROID = "{http://schemas.android.com/apk/res/android}"
EXPECTED = {
    "android.permission.INTERNET",
    "android.permission.RECORD_AUDIO",
    "android.permission.MODIFY_AUDIO_SETTINGS",
    "android.permission.CAPTURE_AUDIO_OUTPUT",
    "android.permission.MODIFY_AUDIO_ROUTING",
    "android.permission.READ_PHONE_STATE",
    "android.permission.CALL_PHONE",
    "android.permission.ANSWER_PHONE_CALLS",
    "android.permission.MANAGE_OWN_CALLS",
    "android.permission.READ_CONTACTS",
    "android.permission.READ_CALL_LOG",
    "android.permission.MODIFY_PHONE_STATE",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_PHONE_CALL",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.WAKE_LOCK",
}

source_manifest, merged_manifest = sys.argv[1:]
for path in (source_manifest, merged_manifest):
    root = ET.parse(path).getroot()
    actual = {
        node.attrib[ANDROID + "name"]
        for node in root.findall("uses-permission")
        if ANDROID + "name" in node.attrib
    }
    expected = set(EXPECTED)
    if path == merged_manifest:
        package_name = root.attrib.get("package", "com.callagent.gateway")
        expected.add(package_name + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
    if actual != expected:
        extra = sorted(actual - expected)
        missing = sorted(expected - actual)
        print(f"Android permission boundary mismatch: {path}", file=sys.stderr)
        if extra:
            print("  unexpected: " + ", ".join(extra), file=sys.stderr)
        if missing:
            print("  missing: " + ", ".join(missing), file=sys.stderr)
        raise SystemExit(1)
PY

printf 'android-permission-boundary-ok\n'
