"""Install reviewed Git blobs without following the destination's symlinks."""
from pathlib import Path
import os
import tempfile


def install_blob(destination: Path, mode: str, data: bytes) -> None:
    """Replace a file or link atomically, preserving its Git mode and link text."""
    if mode not in {"100644", "100755", "120000"}:
        raise ValueError(f"Unsupported Git file mode: {mode}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".baseline-", dir=destination.parent) as directory:
        staged = Path(directory) / "item"
        if mode == "120000":
            staged.symlink_to(os.fsdecode(data))
        else:
            staged.write_bytes(data)
            staged.chmod(0o755 if mode == "100755" else 0o644)
        os.replace(staged, destination)


def verify_blob(destination: Path, mode: str, data: bytes) -> None:
    """Check link identity separately from the contents reached through a link."""
    if mode == "120000":
        if not destination.is_symlink() or os.fsencode(destination.readlink()) != data:
            raise ValueError(f"Wrong baseline symlink: {destination}")
    elif destination.is_symlink() or destination.read_bytes() != data:
        raise ValueError(f"Wrong baseline file: {destination}")
    elif bool(destination.stat().st_mode & 0o111) != (mode == "100755"):
        raise ValueError(f"Wrong executable mode: {destination}")
