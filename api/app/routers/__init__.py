"""Domain routers for the AIRES API (ADR 0007).

Each module in this package owns one cohesive slice of the URL surface:
- system    — /api/health, /api/simulator/tick
- registry  — /api/apps
- requests  — /api/requests (CRUD + interview + submit)
- gates     — approve / send-back / respond / cancel / retry
- events    — comments, event feed, inbox
"""
