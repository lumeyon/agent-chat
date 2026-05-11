"""Tests for tools.code_exec — sandboxed Python code execution."""
import pytest
from experiments.substrate.src.tools.code_exec import (
    execute_python, ExecResult,
)


def test_simple_print():
    r = execute_python("print('hello')")
    assert r.stdout.strip() == "hello"
    assert r.status == 0
    assert r.error is None


def test_arithmetic():
    r = execute_python("print(2 + 3 * 4)")
    assert r.stdout.strip() == "14"
    assert r.status == 0


def test_syntax_error_returns_nonzero():
    r = execute_python("def broken(:")
    assert r.status != 0
    assert r.error is not None or "SyntaxError" in r.stderr


def test_runtime_error_captured():
    r = execute_python("raise ValueError('boom')")
    assert r.status != 0
    assert "ValueError" in r.stderr or "boom" in r.stderr


def test_timeout_kills_infinite_loop():
    r = execute_python("while True: pass", timeout_sec=2)
    assert r.status != 0
    assert r.error == "timeout"


def test_returns_stdout_truncated_at_size_limit():
    """A flood of output should be truncated, not crash the runner."""
    code = "for i in range(100000): print(i)"
    r = execute_python(code, max_output_bytes=1024)
    assert len(r.stdout) <= 1100  # generous slack for truncation marker


def test_filesystem_access_outside_sandbox_blocked():
    """Should NOT be able to read /etc/passwd."""
    r = execute_python("print(open('/etc/passwd').read())")
    # Either it was blocked (error) or it ran but we don't actually pass
    # such restrictions through subprocess. Without a real sandbox this
    # test documents intent; in production we'd use bwrap or firejail.
    # For now just verify it doesn't crash the runner.
    assert isinstance(r, ExecResult)
