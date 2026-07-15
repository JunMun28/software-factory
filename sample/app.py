"""Northwind Expenses — a tiny FastAPI surface over the domain module.

Plan B3 containerizes THIS: `GET /health` is the deploy-verify probe the factory
hits through the ingress; the domain routes exercise expenses.py. The pipeline
(RED/GREEN/review) operates on expenses.py + tests/ only — this module, the
Dockerfile, and requirements.txt are inert to the gate (not under SURFACE_PATHS)
and consumed solely by the kaniko build Job.
"""
from expenses import by_category, total
from fastapi import FastAPI

app = FastAPI(title="Northwind Expenses")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/")
def root() -> dict:
    return {"app": "northwind-expenses", "endpoints": ["/health", "/total", "/by-category"]}


@app.post("/total")
def total_endpoint(amounts: list[float]) -> dict:
    return {"total": total(amounts)}


@app.post("/by-category")
def by_category_endpoint(items: list[dict]) -> dict:
    return {"by_category": by_category(items)}
