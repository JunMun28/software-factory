# Agent Rules — Golden Template

## Angular Best Practices

<!-- Source: https://angular.dev/assets/context/best-practices.md -->

You are an expert in TypeScript, Angular, and scalable web application development. You write functional, maintainable, performant, and accessible code following Angular and TypeScript best practices.

### TypeScript Best Practices

- Use strict type checking
- Prefer type inference when the type is obvious
- Avoid the `any` type; use `unknown` when type is uncertain

### Angular Best Practices

- Always use standalone components over NgModules
- Must NOT set `standalone: true` inside Angular decorators. It's the default in Angular v20+.
- Do NOT set `changeDetection: ChangeDetectionStrategy.OnPush` explicitly. `OnPush` is the default in Angular v22+.
- Use signals for state management
- Implement lazy loading for feature routes
- Do NOT use the `@HostBinding` and `@HostListener` decorators. Put host bindings inside the `host` object of the `@Component` or `@Directive` decorator instead
- Use `NgOptimizedImage` for all static images.`NgOptimizedImage` does not work for inline base64 images.

### Accessibility Requirements

- It MUST pass all AXE checks.
- It MUST follow all WCAG AA minimums, including focus management, color contrast, and ARIA attributes.

#### Components

- Keep components small and focused on a single responsibility
- Use `input()` and `output()` functions instead of decorators
- Use `computed()` for derived state
- Prefer inline templates for small components
- Prefer Signal Forms (`@angular/forms/signals`) for new forms. They are stable in Angular v22+ and provide signal-based state, type-safe field access, and schema-based validation
- When not using Signal Forms, prefer Reactive forms instead of Template-driven ones
- Do NOT use `ngClass`, use `class` bindings instead
- Do NOT use `ngStyle`, use `style` bindings instead
- When using external templates/styles, use paths relative to the component TS file.

### State Management

- Use signals for local component state
- Use `computed()` for derived state
- Keep state transformations pure and predictable
- Do NOT use `mutate` on signals, use `update` or `set` instead

### Templates

- Keep templates simple and avoid complex logic
- Use native control flow (`@if`, `@for`, `@switch`) instead of `*ngIf`, `*ngFor`, `*ngSwitch`
- Use the async pipe to handle observables
- Do not assume globals like (`new Date()`) are available.

### Services

- Design services around a single responsibility
- Use the `providedIn: 'root'` option for singleton services
- Prefer the `@Service` decorator over `@Injectable({providedIn: 'root'})` for new singleton services (Angular v22+)
- Use the `inject()` function instead of constructor injection

## House Rules

- **Standalone only** — no NgModules.
- **Signals for state** — prefer signals and `computed()` over mutable class fields.
- **Native control flow** — use `@if`, `@for`, `@switch`; never `*ngIf`, `*ngFor`, `*ngSwitch`.
- **`inject()` not constructor DI** — use the `inject()` function for dependency injection.
- **Zoneless** — the app uses `provideZonelessChangeDetection()`; do not assume `zone.js` or `NgZone`.
- **spartan/ui + Tailwind** — use helm components from `frontend/libs/ui/` for all UI; style with Tailwind utility classes.
- **Backend under `/api`** — FastAPI + SQLModel; schema changes require updating `backend/app/seed.py` (idempotent seed).
- **Run the Gate** — always run `./gate.sh` from the template root and confirm `GATE GREEN` before declaring a turn done.
- **Never commit** — the platform handles version control.
- **Never touch directly** — `.git`, `node_modules`, `dist`, `.venv`, `app.db`.

## Project Map

```
golden-template/
  gate.sh          # Quality gate — run before every turn
  AGENTS.md        # This file
  opencode.json    # MCP server configuration
  frontend/        # Angular app (standalone, zoneless, spartan/ui)
  backend/         # FastAPI + SQLModel + SQLite
```

### Frontend (`frontend/`)

- Angular app with Tailwind CSS v4 and spartan/ui helm components in `libs/ui/`.
- Dev server proxies `/api` to FastAPI via `proxy.conf.json`.
- Start: `cd frontend && npm start` (serves on http://localhost:4200 with proxy).

### Backend (`backend/`)

- FastAPI app at `app/main.py`; SQLite database at `app.db` (gitignored).
- `app/db.py` — engine and `create_tables()`.
- `app/seed.py` — idempotent seed script; update when schema changes.
- Start: `cd backend && uv run uvicorn app.main:app --port 8000`.
- Lint: `cd backend && uv run ruff check .`
- Start check: `cd backend && uv run python -m app.startcheck`
