"""Orchestrate K candidates per agent for a single query.

For each agent in the requested set, run the corresponding API/runtime
K times in parallel via threads (subprocess parallelism is fine for
API-based agents). Returns an EnsembleResult collating all candidates.

Local-model agents (Qwen-2.5-7B via vLLM) will be added as a third
runner type once vLLM is installed and verified on the 4090."""
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from .api_runners import run_claude, run_codex, RunResult
from .local_runner import run_qwen_local


_RUNNERS = {
    "claude": run_claude,
    "codex": run_codex,
    "qwen-local": run_qwen_local,
}

# Agents that share the GPU and shouldn't be parallelized — running multiple
# concurrent generations on the same GPU causes contention. Serialize these.
_LOCAL_GPU_AGENTS = {"qwen-local"}


@dataclass
class EnsembleResult:
    query: str
    per_agent: dict[str, list[RunResult]]
    meta: dict = field(default_factory=dict)


def run_ensemble(
    query: str,
    K: int = 3,
    agents: list[str] = ("claude", "codex"),
    per_agent_timeout_sec: int = 240,
    max_concurrent: int = 6,
) -> EnsembleResult:
    """Run K candidates per agent in parallel. Total LLM calls = K * len(agents)."""
    unknown = [a for a in agents if a not in _RUNNERS]
    if unknown:
        raise ValueError(f"unknown agents: {unknown}; available: {list(_RUNNERS)}")

    per_agent: dict[str, list[RunResult]] = {a: [] for a in agents}
    t0 = time.time()

    # Split agents: API agents run in parallel (network-bound); local-GPU
    # agents run sequentially (GPU-bound, contention dominates).
    api_agents = [a for a in agents if a not in _LOCAL_GPU_AGENTS]
    local_agents = [a for a in agents if a in _LOCAL_GPU_AGENTS]

    # API agents in parallel.
    api_tasks = [(agent, k) for agent in api_agents for k in range(K)]

    def _do_api(task):
        agent, _k = task
        runner = _RUNNERS[agent]
        # API runners take timeout_sec; local runner uses different params.
        return agent, runner(query, timeout_sec=per_agent_timeout_sec)

    if api_tasks:
        with ThreadPoolExecutor(max_workers=max_concurrent) as ex:
            for agent, result in ex.map(_do_api, api_tasks):
                per_agent[agent].append(result)

    # Local agents sequentially (vary seed for diversity across K calls).
    for agent in local_agents:
        runner = _RUNNERS[agent]
        for k in range(K):
            result = runner(query, seed=k * 1000 + 7)
            per_agent[agent].append(result)

    return EnsembleResult(
        query=query,
        per_agent=per_agent,
        meta={
            "K": K,
            "agents": list(agents),
            "total_elapsed_ms": int((time.time() - t0) * 1000),
            "per_agent_timeout_sec": per_agent_timeout_sec,
            "max_concurrent": max_concurrent,
        },
    )
