import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectionService,
  type ConnectionSummary,
} from '../../services/connection.service';
import { AddConnectionDialog } from './add-connection-dialog';

describe('AddConnectionDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('switches the visible fields when the connection kind changes', async () => {
    const { fixture } = await createFixture();

    expect(field(fixture, 'host')).toBeTruthy();
    expect(field(fixture, 'account')).toBeNull();
    expect(field(fixture, 'base_url')).toBeNull();

    fixture.nativeElement.querySelector('[data-connection-kind="snowflake"]').click();
    fixture.detectChanges();

    expect(field(fixture, 'host')).toBeNull();
    expect(field(fixture, 'account')).toBeTruthy();
    expect(field(fixture, 'warehouse')).toBeTruthy();

    fixture.nativeElement.querySelector('[data-connection-kind="rest"]').click();
    fixture.detectChanges();

    expect(field(fixture, 'account')).toBeNull();
    expect(field(fixture, 'base_url')).toBeTruthy();
    expect(field(fixture, 'auth_header')).toBeTruthy();
    expect(field(fixture, 'auth_value')).toBeTruthy();
  });

  it('renders a server field error under the matching input and stays open', async () => {
    const create = vi.fn().mockResolvedValue({
      ok: false as const,
      errors: [{ path: 'host', message: 'Host is not reachable' }],
    });
    const { fixture } = await createFixture(create);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    fillMssqlForm(fixture, 'temporary-password');

    fixture.nativeElement.querySelector('[data-add-connection-save]').click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-field-error="host"]').textContent).toContain(
        'Host is not reachable',
      );
    });
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeTruthy();
    expect(closed).not.toHaveBeenCalled();
  });

  it('emits the created connection, closes, and clears secret signal state on success', async () => {
    const connection: ConnectionSummary = {
      id: 'connection-1',
      chatId: 'chat-1',
      name: 'Reporting DB',
      kind: 'mssql',
      config: {
        host: 'db.example.com',
        port: '1433',
        database: 'reporting',
        user: 'readonly',
      },
      createdAt: '2026-07-18T08:00:00.000Z',
    };
    const create = vi.fn().mockResolvedValue({ ok: true as const, connection });
    const { fixture } = await createFixture(create);
    const secretState = fixture.componentInstance as unknown as {
      password: () => string;
      authValue: () => string;
    };
    const created = vi.fn(() => {
      expect(secretState.password()).toBe('');
      expect(secretState.authValue()).toBe('');
    });
    const closed = vi.fn();
    fixture.componentInstance.created.subscribe(created);
    fixture.componentInstance.closed.subscribe(closed);
    const password = 'never-persist-this-password';
    fillMssqlForm(fixture, password);

    fixture.nativeElement.querySelector('[data-add-connection-save]').click();

    await vi.waitFor(() => {
      expect(created).toHaveBeenCalledWith(connection);
    });
    fixture.detectChanges();

    expect(closed).toHaveBeenCalledTimes(1);
    expect((field(fixture, 'password') as HTMLInputElement).value).toBe('');
    expect(JSON.stringify(created.mock.calls)).not.toContain(password);
  });
});

async function createFixture(create = vi.fn()) {
  await TestBed.configureTestingModule({
    imports: [AddConnectionDialog],
    providers: [{ provide: ConnectionService, useValue: { create } }],
  }).compileComponents();
  const fixture = TestBed.createComponent(AddConnectionDialog);
  fixture.componentRef.setInput('chatId', 'chat-1');
  fixture.detectChanges();
  return { fixture, create };
}

function fillMssqlForm(
  fixture: ComponentFixture<AddConnectionDialog>,
  password: string,
): void {
  setField(fixture, 'name', 'Reporting DB');
  setField(fixture, 'host', 'db.example.com');
  setField(fixture, 'database', 'reporting');
  setField(fixture, 'user', 'readonly');
  setField(fixture, 'password', password);
}

function setField(
  fixture: ComponentFixture<AddConnectionDialog>,
  name: string,
  value: string,
): void {
  const input = field(fixture, name) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

function field(
  fixture: ComponentFixture<AddConnectionDialog>,
  name: string,
): HTMLInputElement | null {
  return fixture.nativeElement.querySelector(`[data-connection-field="${name}"]`);
}
