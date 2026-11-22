
"""Local LLM egress sidecar on :4000.

Harnesses call this with dummy token sk-sidecar-local. The sidecar injects the
real upstream key from the process environment (ORCA_LLM_API_KEY preferred,
then CUSTOM_LLM_API_KEY / OPENROUTER_*). Secrets are never logged.
"""

from __future__ import annotations

import os

import httpx
import uvicorn
from fastapi import FastAPI, Request, Response

from app.config import settings

app = FastAPI(title="Orca Pod LLM Sidecar")


def upstream_key() -> str:
    # Prefer the live process env so a newly provided ORCA_LLM_API_KEY wins
    # over a stale value previously written to .env.
    return (
        (os.environ.get("ORCA_LLM_API_KEY") or "").strip()
        or (os.environ.get("CUSTOM_LLM_API_KEY") or "").strip()
        or (settings.custom_llm_api_key or "").strip()
        or (os.environ.get("OPENROUTER_API_KEY") or "").strip()
        or (os.environ.get("OPENROUTER_USER_API_KEY") or "").strip()
    )


def upstream_base() -> str:
    return settings.custom_llm_endpoint.rstrip("/")


@app.get("/health")
def health() -> dict:
    key = upstream_key()
    return {"ok": bool(key), "configured": bool(key), "endpoint": upstream_base(), "has_key": bool(key)}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy(path: str, request: Request) -> Response:
    key = upstream_key()
    if not key:
        return Response(
            content='{"error":{"message":"No ORCA_LLM_API_KEY / CUSTOM_LLM_API_KEY configured on the sidecar"}}',
            status_code=503,
            media_type="application/json",
        )
    # Accept dummy sidecar tokens from harnesses
    body = await request.body()
    url_path = path if path.startswith("v1/") or path.startswith("/v1/") else path
    if not url_path.startswith("v1") and not url_path.startswith("/"):
        # OpenAI clients use /v1/chat/completions
        pass
    base = upstream_base()
    target_path = path.lstrip("/")
    # If both the upstream base and the incoming path include /v1, don't double it.
    if base.rstrip("/").endswith("/v1") and target_path.startswith("v1/"):
        target_path = target_path[3:]
    url = f"{base.rstrip('/')}/{target_path}"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": request.headers.get("content-type", "application/json"),
        "HTTP-Referer": "https://orca-digital-pod.local",
        "X-Title": "Orca Digital Pod",
    }
    # If body is JSON chat completions without model, inject default
    content = body
    if body:
        try:
            import json

            data = json.loads(body)
            if isinstance(data, dict) and request.method == "POST" and "chat/completions" in path:
                model = data.get("model") or settings.custom_llm_model
                # LiteLLM/OpenRouter model ids may include a provider prefix; keep as-is
                if model == "default":
                    data["model"] = settings.custom_llm_model.split("openrouter/")[-1] if "openrouter.ai" in base else settings.custom_llm_model
                elif model.startswith("openrouter/") and "openrouter.ai" in base:
                    data["model"] = model.split("openrouter/", 1)[-1]
                content = json.dumps(data).encode()
        except Exception:
            content = body
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.request(request.method, url, content=content, headers=headers)
    return Response(content=resp.content, status_code=resp.status_code, media_type=resp.headers.get("content-type"))


def main() -> None:
    uvicorn.run(app, host="127.0.0.1", port=settings.llm_proxy_port, log_level="info")


if __name__ == "__main__":
    main()
