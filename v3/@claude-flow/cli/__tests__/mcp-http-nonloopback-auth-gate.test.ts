// Dream Cycle 2026-10-01 (security): the MCP HTTP transport's
// `startHttpServer()` called `createMCPServer()` without ever setting
// `requireToolAuthorization` or installing a `toolAuthorizer`. Since
// @claude-flow/mcp's tool-call authorization is fully opt-in
// (ToolRegistry.authorizer is only consulted `if (this.authorizer)`), every
// one of the CLI's 300+ registered MCP tools (memory_*, hooks_*, agentdb_*,
// hive-mind_*, ...) was callable with zero authorization check whenever the
// server was reachable — and `--host` is a live, user-facing flag that can
// bind it off loopback. This is the same shape as CVE-2026-81735 (CVSS
// 10/10, UI-TARS-desktop mcp-http-server): an optional auth hook the
// integrating CLI never wired, combined with a non-loopback-capable bind.
//
// Fix: `startHttpServer()` now refuses to start when the configured host is
// not loopback (localhost/127.0.0.1/::1) unless the operator explicitly sets
// RUFLO_MCP_ALLOW_UNAUTHENTICATED_HTTP=1. Default/loopback behavior (the
// common case, exercised by mcp-http-foreground-2984 and
// mcp-http-protocol-tools-2990) is unchanged.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnauthenticatedHttpAllowed } from '../src/mcp-server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'bin', 'cli.js');
const CLI_BUILT = fs.existsSync(CLI);
const TEST_TMP = path.resolve(HERE, '..', '..', '..', '..', '.tmp-dream-2026-10-01', 'test-runtime');

let child: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;
});

function waitForEither(
  proc: ChildProcessWithoutNullStreams,
  match: string,
  timeoutMs: number,
): Promise<{ matched: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (matched: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ matched, exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => finish(false, null), timeoutMs);
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(match)) finish(true, null);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes(match)) finish(true, null);
    });
    proc.once('exit', (code) => finish(stdout.includes(match) || stderr.includes(match), code));
  });
}

function spawnHttpCli(port: number, host: string, extraEnv: Record<string, string> = {}) {
  fs.mkdirSync(TEST_TMP, { recursive: true });
  return spawn('node', [CLI, 'mcp', 'start', '-t', 'http', '--host', host, '--port', String(port)], {
    env: {
      ...process.env,
      RUFLO_MCP_ALLOW_UNAUTHENTICATED_HTTP: undefined,
      RUFLO_DAEMON_AUTOSTART: '0',
      TEMP: TEST_TMP,
      TMP: TEST_TMP,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('isUnauthenticatedHttpAllowed (unit)', () => {
  it('is false when unset', () => {
    expect(isUnauthenticatedHttpAllowed({})).toBe(false);
  });
  it('is false for arbitrary truthy-looking strings', () => {
    expect(isUnauthenticatedHttpAllowed({ RUFLO_MCP_ALLOW_UNAUTHENTICATED_HTTP: 'yes' })).toBe(false);
    expect(isUnauthenticatedHttpAllowed({ RUFLO_MCP_ALLOW_UNAUTHENTICATED_HTTP: '0' })).toBe(false);
    expect(isUnauthenticatedHttpAllowed({ RUFLO_MCP_ALLOW_UNAUTHENTICATED_HTTP: 'false' })).toBe(false);
  });
  it('is true only for the documented opt-out values', () => {
    expect(isUnauthenticatedHttpAllowed({ RUFLO_MCP_ALLOW_UNAUTHENTICATED_HTTP: '1' })).toBe(true);
    expect(isUnauthenticatedHttpAllowed({ RUFLO_MCP_ALLOW_UNAUTHENTICATED_HTTP: 'true' })).toBe(true);
  });
});

describe('MCP HTTP non-loopback authorization gate (end-to-end)', () => {
  beforeAll(() => {
    if (!CLI_BUILT) {
      throw new Error(`Built CLI required for end-to-end coverage: ${CLI}`);
    }
  });

  it('refuses to start on a non-loopback host with no authorizer and no opt-out', async () => {
    const port = 38000 + Math.floor(Math.random() * 4000);
    child = spawnHttpCli(port, '0.0.0.0');
    const result = await waitForEither(child, 'RUFLO_MCP_ALLOW_UNAUTHENTICATED_HTTP', 15_000);

    expect(result.matched).toBe(true);
    expect(result.stderr).toMatch(/Refusing to start the MCP HTTP server on non-loopback host/);

    // The port must never actually open — not just that an error was logged.
    await expect(
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
    ).rejects.toBeTruthy();
  }, 20_000);

  it('starts normally on a non-loopback host when the explicit opt-out is set', async () => {
    const port = 38000 + Math.floor(Math.random() * 4000);
    child = spawnHttpCli(port, '0.0.0.0', { RUFLO_MCP_ALLOW_UNAUTHENTICATED_HTTP: '1' });
    const result = await waitForEither(child, 'MCP Server started', 20_000);

    expect(result.matched).toBe(true);
    expect(result.exitCode).toBeNull();

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
  }, 25_000);

  it('still starts normally on a loopback host with no opt-out needed', async () => {
    // Uses 127.0.0.1 rather than the 'localhost' default to avoid this
    // sandbox's unrelated, pre-existing lack of IPv6 support (the
    // 'localhost' path additionally binds ::1 — see #2990's identical
    // EAFNOSUPPORT failure on this same host, independent of this candidate).
    const port = 38000 + Math.floor(Math.random() * 4000);
    child = spawnHttpCli(port, '127.0.0.1');
    const result = await waitForEither(child, 'MCP Server started', 20_000);

    expect(result.matched).toBe(true);
    expect(result.exitCode).toBeNull();

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
  }, 25_000);
});
