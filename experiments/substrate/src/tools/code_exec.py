"""Sandboxed Python code execution.

v0.1 uses subprocess with timeout + output size limit. NOT a true sandbox
(no filesystem isolation, no syscall filtering). For production safety
in component 6's tool-use rollouts we'd graduate to bwrap (Linux), but
v0.1's subprocess form is good enough for the substrate's first iteration
on benign math/QA tasks where the model has no incentive to escape.

Returns ExecResult with stdout, stderr, status, optional error string."""
import subprocess
import sys
import tempfile
import os
from dataclasses import dataclass


@dataclass
class ExecResult:
    stdout: str
    stderr: str
    status: int
    elapsed_ms: int
    error: str | None = None


def execute_python(
    code: str,
    timeout_sec: float = 10.0,
    max_output_bytes: int = 64 * 1024,
) -> ExecResult:
    """Run `code` in a subprocess Python, capturing stdout/stderr.

    Args:
      code: Python source.
      timeout_sec: kill after this many seconds.
      max_output_bytes: truncate stdout/stderr at this size.
    """
    import time
    t0 = time.time()
    # Write code to a temp file in /data/tmp (per CLAUDE.md TMPDIR rules)
    tmp_dir = os.environ.get("TMPDIR", "/data/tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", dir=tmp_dir, delete=False, encoding="utf-8"
    ) as f:
        f.write(code)
        path = f.name
    try:
        try:
            r = subprocess.run(
                [sys.executable, "-I", path],  # -I = isolated mode (no PYTHONPATH/USER_SITE)
                capture_output=True,
                text=True,
                timeout=timeout_sec,
            )
            stdout = (r.stdout or "")[:max_output_bytes]
            stderr = (r.stderr or "")[:max_output_bytes]
            elapsed_ms = int((time.time() - t0) * 1000)
            return ExecResult(
                stdout=stdout, stderr=stderr, status=r.returncode,
                elapsed_ms=elapsed_ms, error=None,
            )
        except subprocess.TimeoutExpired:
            return ExecResult(
                stdout="", stderr="", status=-1,
                elapsed_ms=int((time.time() - t0) * 1000), error="timeout",
            )
        except Exception as e:
            return ExecResult(
                stdout="", stderr=str(e), status=-1,
                elapsed_ms=int((time.time() - t0) * 1000),
                error=f"{type(e).__name__}: {str(e)[:200]}",
            )
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
