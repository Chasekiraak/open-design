import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { runVelaCommand } from '../../src/integrations/vela-command.js';
import { runVelaResourceCommand } from '../../src/collab/vela-cli-resource-adapter.js';

describe('runVelaCommand', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, '{"ok":true}\n'),
    );
  });

  it('uses the configured AMR binary and feature-test login profile', async () => {
    const stdout = await runVelaCommand(['resource', 'head', 'project-1'], {
      env: {
        ...process.env,
        VELA_BIN: process.execPath,
        OPEN_DESIGN_AMR_PROFILE: 'feature-test',
        OD_DATA_DIR: '',
      },
    });

    expect(stdout).toBe('{"ok":true}\n');
    const [command, args, options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['resource', 'head', 'project-1']);
    expect(options.env.VELA_PROFILE).toBe('feature-test');
    expect(options.env.AMR_CLIENT_SOURCE).toBe('open_design');
  });

  it('keeps the Settings-backed AMR binary authoritative over inherited VELA_BIN', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'od-vela-command-'));
    try {
      writeFileSync(
        path.join(dataDir, 'app-config.json'),
        JSON.stringify({
          agentCliEnv: { amr: { VELA_BIN: process.execPath } },
        }),
      );

      await runVelaCommand(['team-projects', 'list'], {
        env: {
          ...process.env,
          VELA_BIN: '/missing/inherited/vela',
          OD_DATA_DIR: dataDir,
        },
      });

      expect(execFileMock.mock.calls[0]?.[0]).toBe(process.execPath);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('lets explicit per-command configuration override inherited resolution', async () => {
    await runVelaCommand(['billing', 'summary'], {
      env: {
        ...process.env,
        VELA_BIN: '/missing/inherited/vela',
        OD_DATA_DIR: '',
      },
      configuredEnv: { VELA_BIN: process.execPath },
    });

    expect(execFileMock.mock.calls[0]?.[0]).toBe(process.execPath);
  });

  it('passes an explicit deadline and terminating signal to the child process', async () => {
    await runVelaCommand(['resource', 'pull', 'project-1'], {
      env: {
        ...process.env,
        VELA_BIN: process.execPath,
        OD_DATA_DIR: '',
      },
      timeoutMs: 30_000,
    });

    const options = execFileMock.mock.calls[0]?.[2] as {
      timeout?: number;
      killSignal?: NodeJS.Signals;
    };
    expect(options.timeout).toBe(30_000);
    expect(options.killSignal).toBe('SIGTERM');
  });

  it('bounds production resource pulls so a stuck child cannot hold the project lock forever', async () => {
    vi.stubEnv('VELA_BIN', process.execPath);
    vi.stubEnv('OD_DATA_DIR', '');
    try {
      await runVelaResourceCommand([
        'pull',
        'project',
        'resource-1',
        '/tmp/project-1',
        '--ref',
        'published',
        '--json',
      ], 'workspace-1');
    } finally {
      vi.unstubAllEnvs();
    }

    const options = execFileMock.mock.calls[0]?.[2] as {
      timeout?: number;
      killSignal?: NodeJS.Signals;
    };
    expect(options.timeout).toBe(30_000);
    expect(options.killSignal).toBe('SIGTERM');
  });
});
