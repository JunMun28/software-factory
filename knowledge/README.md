# Organizational knowledge

These files give the intake brain stable context before it asks a follow-up question. `glossary.md` explains internal language, `teams.yaml` supplies team-routing candidates, and `data-sources.yaml` describes approved data sources. The same YAML files also back the brain's read-only lookup tools.

Everything in this directory is example content until your organization replaces it. Suggested ownership:

- Business and platform owners maintain glossary definitions.
- Service or portfolio owners maintain team scopes, contacts, and queues.
- Data governance and source owners maintain the data-source catalog and access notes.

Review changes like any other production prompt change: keep descriptions factual, avoid secrets, and make scopes specific enough that a model can distinguish neighboring teams. The files are loaded once per API process, so restart the API after changing them.

Keep the combined context below roughly 50,000 tokens so the shared prompt prefix remains cheap and useful. Phase 5.4 of Plan 008 defers embeddings or Azure AI Search until at least one retrieval trigger is real: knowledge exceeds about 100,000 tokens, prompt-cache miss cost becomes material, or SQL search over past apps visibly stops returning relevant results. Until then, these small editable files are the source of truth.
