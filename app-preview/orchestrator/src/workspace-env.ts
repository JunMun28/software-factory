const ALLOWED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'TERM',
  'USER',
  'LOGNAME',
  'LANG',
  'TMPDIR',
  'TZ',
  'NVM_DIR',
  'PYENV_ROOT',
]);

const ALLOWED_ENV_PREFIXES = ['LC_', 'UV_', 'NODE_'];
const SECRET_KEY_PARTS = ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL'];
const SECRET_KEY_PREFIXES = [
  'ANTHROPIC',
  'OPENAI',
  'GEMINI',
  'GOOGLE',
  'AWS',
  'AZURE',
  'OPENCODE',
];

// Workspace code is untrusted. Start empty and copy only build/runtime
// essentials; this also intentionally excludes PORT and npm_config_port.
export function workspaceEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || isSecretKey(key) || !isAllowedKey(key)) {
      continue;
    }
    env[key] = value;
  }

  return env;
}

function isAllowedKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  return (
    ALLOWED_ENV_KEYS.has(upperKey) ||
    ALLOWED_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))
  );
}

function isSecretKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  return (
    SECRET_KEY_PARTS.some((part) => upperKey.includes(part)) ||
    SECRET_KEY_PREFIXES.some((prefix) => upperKey.startsWith(prefix))
  );
}
