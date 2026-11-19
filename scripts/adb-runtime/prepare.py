"""Package pinned open-source ADB files and the material needed to rebuild them."""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import zipfile


HERE = Path(__file__).resolve().parent
CLIENT_LOCK = HERE.parents[1] / (
    "nuwa-electron-shell/crates/agent-electron-client/src/main/features/android/adbRuntimeMirror.json"
)


def metadata(data):
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def runtime_lock():
    return json.loads(CLIENT_LOCK.read_text())


def load_input(directory, name, spec):
    file = directory / name
    if not file.exists():
        download = file.with_name(name + ".part")
        command = [
            "curl", "--fail", "--silent", "--show-error", "--location",
            "--connect-timeout", "10", "--max-time", "50", "--proto", "=https",
            spec["url"], "--output", download,
        ]
        if spec.get("resume"):
            command.extend(["--continue-at", "-"])
        for attempt in range(4):
            result = subprocess.run(command, check=False)
            if result.returncode == 0:
                break
            if attempt == 3:
                result.check_returncode()
        content = download.read_bytes()
        if spec.get("base64"):
            content = base64.b64decode(content)
        if metadata(content)["sha256"] != spec["sha256"]:
            raise ValueError(f"{name}: unexpected upstream SHA256")
        download.unlink()
        file.write_bytes(content)
    data = file.read_bytes()
    if metadata(data)["sha256"] != spec["sha256"]:
        raise ValueError(f"{name}: unexpected upstream SHA256")
    return data


def read_files(filename, contents, required):
    def selected(names, read):
        result = {}
        for target, base in required.items():
            matches = [name for name in names if PurePosixPath(name).name == base]
            if len(matches) != 1:
                raise ValueError(f"{filename}: expected exactly one {base}")
            result[target] = read(matches[0])
        return result

    if filename.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(contents)) as archive:
            return selected(archive.namelist(), archive.read)
    with tarfile.open(fileobj=io.BytesIO(contents), mode="r:gz") as archive:
        return selected(
            [entry.name for entry in archive.getmembers() if entry.isfile()],
            lambda name: archive.extractfile(name).read(),
        )


def build_sources(data, specs, windows_files, output):
    with tarfile.open(output, "w", format=tarfile.USTAR_FORMAT) as kit:
        def add(name, content, executable=False):
            entry = tarfile.TarInfo("adb-source/" + name)
            entry.size = len(content)
            entry.mode = 0o755 if executable else 0o644
            kit.addfile(entry, io.BytesIO(content))

        pin = specs["pinkyCommit"]
        readme = (
            f"Corresponding source for the ADB builds from DIYgod/pinky commit {pin}.\n"
            "The upstream script verifies the source files in adb-sources against\n"
            "its built-in SHA256 checksums. From this directory, run\n"
            "sh scripts/adb.sh \"$PWD/output\" <target>.\n"
            "Targets are arm64, amd64, windows-amd64 and linux-amd64.\n"
            "See the platform BUILD and NOTICE files for build and license information.\n"
        )
        add("README.txt", readme.encode())
        for name in specs["dependencies"]:
            add(f"adb-sources/{name}", data[name])
        for name in ("AdbWinApi.dll", "AdbWinUsbApi.dll"):
            add(f"adb-sources/{name}", windows_files[name])
        for platform, files in specs["receipts"].items():
            for name, content in files.items():
                add(f"receipts/{platform}/{name}", content)
        for name, source in specs["buildScripts"].items():
            add(name, data[source], name.endswith(".sh"))


def prepare(version, root, print_lock):
    lock = runtime_lock()
    if version != lock["version"]:
        raise ValueError(f"expected pinned ADB version {lock['version']}")
    specs = json.loads((HERE / "upstream.json").read_text())
    inputs = root / "inputs"
    output = root / "output"
    inputs.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=6) as pool:
        downloads = {name: pool.submit(load_input, inputs, name, spec)
                     for name, spec in specs["inputs"].items()}
        data = {name: task.result() for name, task in downloads.items()}
    releases = {}
    runtime_files = {}
    source_url = f"{lock['baseUrl']}/{version}/{lock['source']}"
    for platform, upstream in specs["platforms"].items():
        executable = "adb.exe" if platform.startswith("win32") else "adb"
        members = {
            executable: executable,
            "NOTICE.txt": "adb-NOTICE.txt",
            "BUILD.txt": "adb-BUILD.txt",
        }
        if executable == "adb.exe":
            members.update({name: name for name in ("AdbWinApi.dll", "AdbWinUsbApi.dll")})
        files = read_files(upstream, data[upstream], members)
        files["BUILD.txt"] += f"\nCorresponding source: {source_url}\n".encode()
        runtime_files[platform] = files
        filename = f"adb-{platform}.zip"
        archive = output / filename
        # Stored entries keep the archive hash independent of the host compressor.
        with zipfile.ZipFile(archive, "w") as bundle:
            for name, content in sorted(files.items()):
                entry = zipfile.ZipInfo("platform-tools/" + name)
                entry.create_system = 3
                entry.external_attr = (0o100755 if name == executable else 0o100644) << 16
                bundle.writestr(entry, content)
        releases[platform] = {
            "name": filename, **metadata(archive.read_bytes()), "executable": executable,
            "files": {name: metadata(content) for name, content in sorted(files.items())},
        }
    specs["receipts"] = {
        platform: {name: files[name] for name in ("NOTICE.txt", "BUILD.txt")}
        for platform, files in runtime_files.items()
    }
    source_archive = output / lock["source"]
    build_sources(data, specs, runtime_files["win32-x64"], source_archive)
    expected = {
        **lock, "platforms": releases, "sourceMetadata": metadata(source_archive.read_bytes())
    }
    if print_lock:
        print(json.dumps(expected, indent=2))
    elif lock != expected:
        raise ValueError("repacked ADB archives differ from the client lock")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--print-lock", action="store_true")
    args = parser.parse_args()
    prepare(args.version, args.directory, args.print_lock)
