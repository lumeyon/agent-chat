"""Subprocess wrappers for the API-based agents (claude, codex).

Both expose the same RunResult shape so the ensemble orchestrator can
treat them uniformly with the local-model runner."""
import subprocess
import time
from dataclasses import dataclass


@dataclass
class RunResult:
    text: str
    elapsed_ms: int
    status: int
    agent: str
    error: str | None = None


def run_claude(prompt: str, timeout_sec: int = 240) -> RunResult:
    t0 = time.time()
    try:
        r = subprocess.run(
            ["claude", "-p", "--output-format", "text", prompt],
            capture_output=True, text=True, timeout=timeout_sec,
        )
        elapsed_ms = int((time.time() - t0) * 1000)
        text = (r.stdout or "").strip()
        err = (r.stderr or "")[:300] if r.returncode != 0 and not text else None
        return RunResult(text=text, elapsed_ms=elapsed_ms, status=r.returncode,
                         agent="claude", error=err)
    except subprocess.TimeoutExpired:
        return RunResult(text="", elapsed_ms=int((time.time() - t0) * 1000),
                         status=-1, agent="claude", error="timeout")
    except FileNotFoundError as e:
        return RunResult(text="", elapsed_ms=int((time.time() - t0) * 1000),
                         status=-1, agent="claude", error=f"not found: {e}")


def run_codex(prompt: str, timeout_sec: int = 240) -> RunResult:
    t0 = time.time()
    try:
        r = subprocess.run(
            ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", prompt],
            capture_output=True, text=True, timeout=timeout_sec,
        )
        elapsed_ms = int((time.time() - t0) * 1000)
        text = (r.stdout or "").strip()
        err = (r.stderr or "")[:300] if r.returncode != 0 and not text else None
        return RunResult(text=text, elapsed_ms=elapsed_ms, status=r.returncode,
                         agent="codex", error=err)
    except subprocess.TimeoutExpired:
        return RunResult(text="", elapsed_ms=int((time.time() - t0) * 1000),
                         status=-1, agent="codex", error="timeout")
    except FileNotFoundError as e:
        return RunResult(text="", elapsed_ms=int((time.time() - t0) * 1000),
                         status=-1, agent="codex", error=f"not found: {e}")
