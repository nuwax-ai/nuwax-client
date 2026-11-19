"""Upload the pinned ADB dependency to the client release bucket."""

import argparse
from pathlib import Path
import subprocess
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from prepare import metadata, runtime_lock


def publish(directory):
    lock = runtime_lock()
    base = urlsplit(lock["baseUrl"])
    bucket, prefix = base.path.strip("/").split("/", 1)
    endpoint = f"{base.scheme}://{base.netloc}"
    assets = [(lock["source"], lock["sourceMetadata"], "application/x-tar")]
    assets += [
        (release["name"], {key: release[key] for key in ("bytes", "sha256")}, "application/zip")
        for release in lock["platforms"].values()
    ]
    for name, expected, _ in assets:
        if metadata((directory / "output" / name).read_bytes()) != expected:
            raise ValueError(f"{name}: local archive differs from lock")

    for name, expected, content_type in assets:
        file = directory / "output" / name
        version = lock["version"]
        url = f"{lock['baseUrl']}/{version}/{name}"
        key = f"{prefix}/{version}/{name}"
        try:
            with urlopen(Request(url, method="HEAD"), timeout=15) as response:
                if int(response.headers["Content-Length"]) != expected["bytes"]:
                    raise ValueError(f"{name}: existing object has an unexpected length")
        except HTTPError as error:
            if error.code != 404:
                raise
            subprocess.run([
                "aws", "--endpoint-url", endpoint, "--region", "us-east-1",
                "s3api", "put-object", "--bucket", bucket, "--key", key,
                "--body", file, "--if-none-match", "*", "--content-type", content_type,
                "--cache-control", "public, max-age=31536000, immutable",
                "--checksum-algorithm", "SHA256", "--no-cli-pager",
            ], check=True, stdout=subprocess.DEVNULL)
        with urlopen(url, timeout=45) as response:
            if metadata(response.read(expected["bytes"] + 1)) != expected:
                raise ValueError(f"{name}: public S3 SHA256 or length mismatch")
        # Verify the unauthenticated endpoint used for client resumption.
        with urlopen(Request(url, headers={"Range": "bytes=0-0"}), timeout=15) as response:
            if (response.status, response.headers["Content-Range"], len(response.read(2))) != (
                206, f"bytes 0-0/{expected['bytes']}", 1
            ):
                raise ValueError(f"{name}: public S3 range check failed")
        print(f"{name}: public readback and Range verified ({expected['sha256']})", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    publish(parser.parse_args().directory)
