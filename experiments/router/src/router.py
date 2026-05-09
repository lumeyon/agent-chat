"""Production interface: load a trained checkpoint, route a single query."""
import torch
from .featurize import _get_embedder, build_features, EXPERTS, DOMAINS
from .model import RouterQNet


class Router:
    def __init__(self, model_path: str, in_dim: int, hidden: int = 128, device: str = "cuda"):
        self.device = device if (device == "cpu" or torch.cuda.is_available()) else "cpu"
        self.model = RouterQNet(in_dim=in_dim, hidden=hidden).to(self.device)
        self.model.load_state_dict(torch.load(model_path, map_location=self.device))
        self.model.eval()

    def route(self, query: str, domain: str, subdomain: str, subdomains: list[str]) -> dict:
        emb = _get_embedder(self.device).encode([query], convert_to_tensor=True, normalize_embeddings=True).float().cpu()
        triple = {"query": query, "domain": domain, "subdomain": subdomain,
                  "codex_correct": False, "claude_correct": False}
        # Build a one-row featurizer matching training-time meta.
        triples_dummy = [{**triple, "subdomain": s} for s in subdomains]  # establish subdomain space
        triples_dummy = [triple]
        # Reuse build_features by passing a fake triple list of size 1 with the right subdomains universe
        # via the meta; but build_features expects triples to define subdomain space. Workaround:
        # just construct the feature vector inline matching the training layout.
        d_oh = torch.zeros(len(DOMAINS))
        d_oh[DOMAINS.index(domain)] = 1.0
        s_oh = torch.zeros(len(subdomains))
        if subdomain in subdomains:
            s_oh[subdomains.index(subdomain)] = 1.0
        scores = {}
        with torch.no_grad():
            for ei, e in enumerate(EXPERTS):
                e_oh = torch.zeros(len(EXPERTS))
                e_oh[ei] = 1.0
                x = torch.cat([emb[0], d_oh, s_oh, e_oh]).unsqueeze(0).to(self.device)
                scores[e] = float(torch.sigmoid(self.model(x)).item())
        return scores
