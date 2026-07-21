import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  type WritableSignal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle, lucideX } from '@ng-icons/lucide';

import { FocusTrap } from '../../lib/focus-trap';
import {
  ConnectionService,
  type ConnectionFieldError,
  type ConnectionSummary,
} from '../../services/connection.service';

type ConnectionKind = ConnectionSummary['kind'];

@Component({
  selector: 'app-add-connection-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FocusTrap, NgIcon],
  providers: [provideIcons({ lucideLoaderCircle, lucideX })],
  template: `
    <div
      data-add-connection-backdrop
      class="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 px-4 py-6"
      (click)="dismiss()"
    >
      <section
        focusTrap
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-connection-title"
        class="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
        (click)="$event.stopPropagation()"
        (focusTrapEscape)="dismiss()"
      >
        <header class="flex shrink-0 items-start gap-4 border-b border-border px-5 py-4">
          <div class="min-w-0 flex-1">
            <h2 id="add-connection-title" class="text-lg font-semibold">Add connection</h2>
            <p class="mt-1 text-sm text-muted-foreground">
              Save a data source for generated code to use while previewing.
            </p>
          </div>
          <button
            type="button"
            class="workspace-icon-button disabled:opacity-40"
            aria-label="Close add connection"
            [disabled]="saving()"
            (click)="dismiss()"
          >
            <ng-icon name="lucideX" size="16" />
          </button>
        </header>

        <form
          class="flex min-h-0 flex-1 flex-col"
          autocomplete="off"
          novalidate
          (submit)="submit($event)"
        >
          <div class="min-h-0 space-y-5 overflow-y-auto px-5 py-4">
            @if (generalErrors().length > 0) {
              <div
                class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                @for (message of generalErrors(); track $index) {
                  <p>{{ message }}</p>
                }
              </div>
            }

            <div>
              <span class="block text-sm font-medium">
                Connection type <span class="text-destructive" aria-hidden="true">*</span>
              </span>
              <div
                class="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
                role="group"
                aria-label="Connection type"
              >
                <button
                  data-connection-kind="mssql"
                  type="button"
                  class="h-9 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-40"
                  [class.bg-background]="kind() === 'mssql'"
                  [class.shadow-sm]="kind() === 'mssql'"
                  [class.text-muted-foreground]="kind() !== 'mssql'"
                  [attr.aria-pressed]="kind() === 'mssql'"
                  [disabled]="saving()"
                  (click)="selectKind('mssql')"
                >
                  MSSQL
                </button>
                <button
                  data-connection-kind="snowflake"
                  type="button"
                  class="h-9 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-40"
                  [class.bg-background]="kind() === 'snowflake'"
                  [class.shadow-sm]="kind() === 'snowflake'"
                  [class.text-muted-foreground]="kind() !== 'snowflake'"
                  [attr.aria-pressed]="kind() === 'snowflake'"
                  [disabled]="saving()"
                  (click)="selectKind('snowflake')"
                >
                  Snowflake
                </button>
                <button
                  data-connection-kind="rest"
                  type="button"
                  class="h-9 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-40"
                  [class.bg-background]="kind() === 'rest'"
                  [class.shadow-sm]="kind() === 'rest'"
                  [class.text-muted-foreground]="kind() !== 'rest'"
                  [attr.aria-pressed]="kind() === 'rest'"
                  [disabled]="saving()"
                  (click)="selectKind('rest')"
                >
                  REST API
                </button>
              </div>
              @if (fieldErrors()['kind']; as message) {
                <p
                  id="connection-kind-error"
                  data-field-error="kind"
                  class="mt-1.5 text-xs text-destructive"
                >
                  {{ message }}
                </p>
              }
            </div>

            <div>
              <label class="block text-sm font-medium" for="connection-name">
                Name <span class="text-destructive" aria-hidden="true">*</span>
              </label>
              <input
                id="connection-name"
                autoFocusTarget
                data-connection-field="name"
                type="text"
                class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                placeholder="e.g. Reporting database"
                [value]="name()"
                [attr.aria-invalid]="fieldErrors()['name'] ? 'true' : null"
                [attr.aria-describedby]="fieldErrors()['name'] ? 'connection-name-error' : null"
                (input)="updateField('name', name, $event)"
              />
              @if (fieldErrors()['name']; as message) {
                <p
                  id="connection-name-error"
                  data-field-error="name"
                  class="mt-1.5 text-xs text-destructive"
                >
                  {{ message }}
                </p>
              }
            </div>

            @if (kind() === 'mssql') {
              <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
                <div>
                  <label class="block text-sm font-medium" for="connection-host">
                    Host <span class="text-destructive" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="connection-host"
                    data-connection-field="host"
                    type="text"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    placeholder="db.example.com"
                    [value]="host()"
                    [attr.aria-invalid]="fieldErrors()['host'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['host'] ? 'connection-host-error' : null"
                    (input)="updateField('host', host, $event)"
                  />
                  @if (fieldErrors()['host']; as message) {
                    <p
                      id="connection-host-error"
                      data-field-error="host"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
                <div>
                  <label class="block text-sm font-medium" for="connection-port">
                    Port <span class="text-xs font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    id="connection-port"
                    data-connection-field="port"
                    type="number"
                    inputmode="numeric"
                    min="1"
                    step="1"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    placeholder="1433"
                    [value]="port()"
                    [attr.aria-invalid]="fieldErrors()['port'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['port'] ? 'connection-port-error' : null"
                    (input)="updateField('port', port, $event)"
                  />
                  @if (fieldErrors()['port']; as message) {
                    <p
                      id="connection-port-error"
                      data-field-error="port"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
              </div>

              <div>
                <label class="block text-sm font-medium" for="connection-mssql-database">
                  Database <span class="text-destructive" aria-hidden="true">*</span>
                </label>
                <input
                  id="connection-mssql-database"
                  data-connection-field="database"
                  type="text"
                  class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                  placeholder="reporting"
                  [value]="database()"
                  [attr.aria-invalid]="fieldErrors()['database'] ? 'true' : null"
                  [attr.aria-describedby]="fieldErrors()['database'] ? 'connection-mssql-database-error' : null"
                  (input)="updateField('database', database, $event)"
                />
                @if (fieldErrors()['database']; as message) {
                  <p
                    id="connection-mssql-database-error"
                    data-field-error="database"
                    class="mt-1.5 text-xs text-destructive"
                  >
                    {{ message }}
                  </p>
                }
              </div>

              <div class="grid gap-4 sm:grid-cols-2">
                <div>
                  <label class="block text-sm font-medium" for="connection-mssql-user">
                    User <span class="text-destructive" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="connection-mssql-user"
                    data-connection-field="user"
                    type="text"
                    autocomplete="off"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    [value]="user()"
                    [attr.aria-invalid]="fieldErrors()['user'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['user'] ? 'connection-mssql-user-error' : null"
                    (input)="updateField('user', user, $event)"
                  />
                  @if (fieldErrors()['user']; as message) {
                    <p
                      id="connection-mssql-user-error"
                      data-field-error="user"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
                <div>
                  <label class="block text-sm font-medium" for="connection-mssql-password">
                    Password <span class="text-destructive" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="connection-mssql-password"
                    data-connection-field="password"
                    type="password"
                    autocomplete="new-password"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    [value]="password()"
                    [attr.aria-invalid]="fieldErrors()['password'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['password'] ? 'connection-mssql-password-error' : null"
                    (input)="updateField('password', password, $event)"
                  />
                  @if (fieldErrors()['password']; as message) {
                    <p
                      id="connection-mssql-password-error"
                      data-field-error="password"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
              </div>
            } @else if (kind() === 'snowflake') {
              <div class="grid gap-4 sm:grid-cols-2">
                <div>
                  <label class="block text-sm font-medium" for="connection-account">
                    Account <span class="text-destructive" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="connection-account"
                    data-connection-field="account"
                    type="text"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    placeholder="organization-account"
                    [value]="account()"
                    [attr.aria-invalid]="fieldErrors()['account'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['account'] ? 'connection-account-error' : null"
                    (input)="updateField('account', account, $event)"
                  />
                  @if (fieldErrors()['account']; as message) {
                    <p
                      id="connection-account-error"
                      data-field-error="account"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
                <div>
                  <label class="block text-sm font-medium" for="connection-warehouse">
                    Warehouse
                    <span class="text-xs font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    id="connection-warehouse"
                    data-connection-field="warehouse"
                    type="text"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    [value]="warehouse()"
                    [attr.aria-invalid]="fieldErrors()['warehouse'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['warehouse'] ? 'connection-warehouse-error' : null"
                    (input)="updateField('warehouse', warehouse, $event)"
                  />
                  @if (fieldErrors()['warehouse']; as message) {
                    <p
                      id="connection-warehouse-error"
                      data-field-error="warehouse"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
              </div>

              <div class="grid gap-4 sm:grid-cols-2">
                <div>
                  <label class="block text-sm font-medium" for="connection-snowflake-database">
                    Database <span class="text-destructive" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="connection-snowflake-database"
                    data-connection-field="database"
                    type="text"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    [value]="database()"
                    [attr.aria-invalid]="fieldErrors()['database'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['database'] ? 'connection-snowflake-database-error' : null"
                    (input)="updateField('database', database, $event)"
                  />
                  @if (fieldErrors()['database']; as message) {
                    <p
                      id="connection-snowflake-database-error"
                      data-field-error="database"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
                <div>
                  <label class="block text-sm font-medium" for="connection-schema">
                    Schema <span class="text-xs font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    id="connection-schema"
                    data-connection-field="schema"
                    type="text"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    [value]="schema()"
                    [attr.aria-invalid]="fieldErrors()['schema'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['schema'] ? 'connection-schema-error' : null"
                    (input)="updateField('schema', schema, $event)"
                  />
                  @if (fieldErrors()['schema']; as message) {
                    <p
                      id="connection-schema-error"
                      data-field-error="schema"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
              </div>

              <div class="grid gap-4 sm:grid-cols-2">
                <div>
                  <label class="block text-sm font-medium" for="connection-snowflake-user">
                    User <span class="text-destructive" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="connection-snowflake-user"
                    data-connection-field="user"
                    type="text"
                    autocomplete="off"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    [value]="user()"
                    [attr.aria-invalid]="fieldErrors()['user'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['user'] ? 'connection-snowflake-user-error' : null"
                    (input)="updateField('user', user, $event)"
                  />
                  @if (fieldErrors()['user']; as message) {
                    <p
                      id="connection-snowflake-user-error"
                      data-field-error="user"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
                <div>
                  <label class="block text-sm font-medium" for="connection-snowflake-password">
                    Password <span class="text-destructive" aria-hidden="true">*</span>
                  </label>
                  <input
                    id="connection-snowflake-password"
                    data-connection-field="password"
                    type="password"
                    autocomplete="new-password"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    [value]="password()"
                    [attr.aria-invalid]="fieldErrors()['password'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['password'] ? 'connection-snowflake-password-error' : null"
                    (input)="updateField('password', password, $event)"
                  />
                  @if (fieldErrors()['password']; as message) {
                    <p
                      id="connection-snowflake-password-error"
                      data-field-error="password"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
              </div>
            } @else {
              <div>
                <label class="block text-sm font-medium" for="connection-base-url">
                  Base URL <span class="text-destructive" aria-hidden="true">*</span>
                </label>
                <input
                  id="connection-base-url"
                  data-connection-field="base_url"
                  type="url"
                  class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                  placeholder="https://api.example.com"
                  [value]="baseUrl()"
                  [attr.aria-invalid]="fieldErrors()['base_url'] ? 'true' : null"
                  [attr.aria-describedby]="fieldErrors()['base_url'] ? 'connection-base-url-error' : null"
                  (input)="updateField('base_url', baseUrl, $event)"
                />
                @if (fieldErrors()['base_url']; as message) {
                  <p
                    id="connection-base-url-error"
                    data-field-error="base_url"
                    class="mt-1.5 text-xs text-destructive"
                  >
                    {{ message }}
                  </p>
                }
              </div>

              <div class="grid gap-4 sm:grid-cols-2">
                <div>
                  <label class="block text-sm font-medium" for="connection-auth-header">
                    Auth header
                    <span class="text-xs font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    id="connection-auth-header"
                    data-connection-field="auth_header"
                    type="text"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    placeholder="Authorization"
                    [value]="authHeader()"
                    [attr.aria-invalid]="fieldErrors()['auth_header'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['auth_header'] ? 'connection-auth-header-error' : null"
                    (input)="updateField('auth_header', authHeader, $event)"
                  />
                  @if (fieldErrors()['auth_header']; as message) {
                    <p
                      id="connection-auth-header-error"
                      data-field-error="auth_header"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
                <div>
                  <label class="block text-sm font-medium" for="connection-auth-value">
                    Auth value
                    <span class="text-xs font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    id="connection-auth-value"
                    data-connection-field="auth_value"
                    type="password"
                    autocomplete="new-password"
                    class="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
                    [value]="authValue()"
                    [attr.aria-invalid]="fieldErrors()['auth_value'] ? 'true' : null"
                    [attr.aria-describedby]="fieldErrors()['auth_value'] ? 'connection-auth-value-error' : null"
                    (input)="updateField('auth_value', authValue, $event)"
                  />
                  @if (fieldErrors()['auth_value']; as message) {
                    <p
                      id="connection-auth-value-error"
                      data-field-error="auth_value"
                      class="mt-1.5 text-xs text-destructive"
                    >
                      {{ message }}
                    </p>
                  }
                </div>
              </div>
            }
          </div>

          <footer
            class="flex shrink-0 flex-col gap-3 border-t border-border px-5 py-4 sm:flex-row sm:items-center"
          >
            <p class="min-w-0 flex-1 text-xs text-muted-foreground">
              You can test the connection once it's saved.
            </p>
            <div class="flex justify-end gap-2">
              <button
                data-add-connection-cancel
                type="button"
                class="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-40"
                [disabled]="saving()"
                (click)="dismiss()"
              >
                Cancel
              </button>
              <button
                data-add-connection-save
                type="submit"
                class="inline-flex h-9 items-center gap-2 rounded-md bg-foreground px-3 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40"
                [disabled]="saving() || !canSubmit()"
              >
                @if (saving()) {
                  <ng-icon class="animate-spin" name="lucideLoaderCircle" size="14" />
                  Saving…
                } @else {
                  Save
                }
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  `,
})
export class AddConnectionDialog {
  private readonly connectionService = inject(ConnectionService);

  readonly chatId = input.required<string>();
  readonly created = output<ConnectionSummary>();
  readonly closed = output<void>();

  readonly kind = signal<ConnectionKind>('mssql');
  readonly name = signal('');
  readonly host = signal('');
  readonly port = signal('1433');
  readonly database = signal('');
  readonly user = signal('');
  protected readonly password = signal('');
  readonly account = signal('');
  readonly warehouse = signal('');
  readonly schema = signal('');
  readonly baseUrl = signal('');
  readonly authHeader = signal('');
  protected readonly authValue = signal('');
  readonly fieldErrors = signal<Record<string, string>>({});
  readonly generalErrors = signal<string[]>([]);
  readonly saving = signal(false);

  readonly canSubmit = computed(() => {
    if (!this.name().trim()) {
      return false;
    }

    if (this.kind() === 'mssql') {
      return Boolean(
        this.host().trim() &&
          this.database().trim() &&
          this.user().trim() &&
          this.password(),
      );
    }

    if (this.kind() === 'snowflake') {
      return Boolean(
        this.account().trim() &&
          this.database().trim() &&
          this.user().trim() &&
          this.password(),
      );
    }

    return Boolean(this.baseUrl().trim());
  });

  dismiss(): void {
    if (this.saving()) {
      return;
    }
    this.clearSecrets();
    this.closed.emit();
  }

  selectKind(kind: ConnectionKind): void {
    if (this.saving() || kind === this.kind()) {
      return;
    }
    this.clearSecrets();
    this.kind.set(kind);
    this.fieldErrors.set({});
    this.generalErrors.set([]);
  }

  updateField(path: string, target: WritableSignal<string>, event: Event): void {
    target.set((event.target as HTMLInputElement).value);
    this.fieldErrors.update((errors) => {
      if (!(path in errors)) {
        return errors;
      }
      const next = { ...errors };
      delete next[path];
      return next;
    });
    this.generalErrors.set([]);
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving() || !this.canSubmit()) {
      return;
    }

    this.saving.set(true);
    this.fieldErrors.set({});
    this.generalErrors.set([]);

    try {
      const result = await this.connectionService.create(this.chatId(), this.buildPayload());
      this.clearSecrets();

      if (result.ok) {
        this.saving.set(false);
        this.created.emit(result.connection);
        this.closed.emit();
        return;
      }

      this.applyErrors(result.errors);
    } catch (error) {
      this.clearSecrets();
      this.generalErrors.set([
        error instanceof Error ? error.message : 'Failed to create connection',
      ]);
    } finally {
      this.saving.set(false);
    }
  }

  private buildPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      name: this.name().trim(),
      kind: this.kind(),
    };

    switch (this.kind()) {
      case 'mssql': {
        payload['host'] = this.host().trim();
        payload['database'] = this.database().trim();
        payload['user'] = this.user().trim();
        payload['password'] = this.password();
        const port = this.port().trim();
        if (port) {
          payload['port'] = port;
        }
        break;
      }
      case 'snowflake': {
        payload['account'] = this.account().trim();
        payload['database'] = this.database().trim();
        payload['user'] = this.user().trim();
        payload['password'] = this.password();
        const warehouse = this.warehouse().trim();
        const schema = this.schema().trim();
        if (warehouse) {
          payload['warehouse'] = warehouse;
        }
        if (schema) {
          payload['schema'] = schema;
        }
        break;
      }
      case 'rest': {
        payload['base_url'] = this.baseUrl().trim();
        const authHeader = this.authHeader().trim();
        const authValue = this.authValue();
        if (authHeader) {
          payload['auth_header'] = authHeader;
        }
        if (authValue) {
          payload['auth_value'] = authValue;
        }
        break;
      }
    }

    return payload;
  }

  private applyErrors(errors: ConnectionFieldError[]): void {
    const allowedPaths = new Set(['name', 'kind', ...this.kindFieldPaths()]);
    const fieldErrors: Record<string, string> = {};
    const generalErrors: string[] = [];

    for (const error of errors) {
      if (error.path && allowedPaths.has(error.path)) {
        fieldErrors[error.path] ??= error.message;
      } else {
        generalErrors.push(error.message);
      }
    }

    this.fieldErrors.set(fieldErrors);
    this.generalErrors.set(generalErrors);
  }

  private kindFieldPaths(): string[] {
    if (this.kind() === 'mssql') {
      return ['host', 'port', 'database', 'user', 'password'];
    }

    if (this.kind() === 'snowflake') {
      return ['account', 'warehouse', 'database', 'schema', 'user', 'password'];
    }

    return ['base_url', 'auth_header', 'auth_value'];
  }

  private clearSecrets(): void {
    this.password.set('');
    this.authValue.set('');
  }
}
