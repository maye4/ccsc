#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { render } from 'ink';
import React from 'react';
import { Command } from 'commander';
import { App } from './ui/App.js';
import { getProviders, isDbAvailable } from './db.js';
import { loadHistory, saveToHistory, sortByHistory } from './history.js';
import { createProviderSettings, clearAllCcscSettings } from './settings.js';
import type { Provider } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const RESOLVED_BIN_SENTINEL = '__CCSC_RESOLVED_BIN__=';
const SHELL_BOOTSTRAP_SCRIPT = `
resolved_bin=''
case "$1" in
  */*) ;;
  *)
    resolved="$(command -v -- "$1" 2>/dev/null || true)"
    case "$resolved" in
      /*) resolved_bin="$resolved" ;;
    esac
    ;;
esac
printf '%s%s\n' "${RESOLVED_BIN_SENTINEL}" "$resolved_bin"
printf '\\0'
env -0
`;
const POSIX_EXEC_TRAMPOLINE = `
trap '' TTOU
if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import os; fd = os.open("/dev/tty", os.O_RDONLY); os.tcsetpgrp(fd, os.getpgrp())' >/dev/null 2>&1 || true
elif command -v python >/dev/null 2>&1; then
  python -c 'import os; fd = os.open("/dev/tty", os.O_RDONLY); os.tcsetpgrp(fd, os.getpgrp())' >/dev/null 2>&1 || true
fi
exec "$@"
`;

const program = new Command();

program
  .name('ccsc')
  .description('Cross-platform CLI for CC Switch provider selection')
  .version(pkg.version)
  .option('--clear', 'Clear all CCSC-generated settings files')
  .option('--cli <name>', 'Specify CLI tool to use (overrides CC_CLI_PATH env)')
  .allowUnknownOption()
  .allowExcessArguments()
  .passThroughOptions()
  .action(async (options) => {
    try {
      // Handle --clear flag
      if (options.clear) {
        const removed = await clearAllCcscSettings();
        if (removed > 0) {
          console.log(`✓ Cleared ${removed} CCSC settings file(s)`);
        } else {
          console.log('No CCSC settings files found');
        }
        process.exit(0);
      }

      // Extract --cli option and remaining args
      const cliOverride = options.cli;
      const rawArgs = process.argv.slice(2).filter(
        (arg) => arg !== '--clear' && !arg.startsWith('--cli') && arg !== cliOverride
      );
      await main(rawArgs, cliOverride);
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  });

program.parse();

function parseNullDelimitedEnv(envBlock: Buffer): Record<string, string> {
  const envEntries: Record<string, string> = {};
  let entryStart = 0;

  for (let index = 0; index <= envBlock.length; index += 1) {
    if (index !== envBlock.length && envBlock[index] !== 0) {
      continue;
    }

    if (index > entryStart) {
      const entry = envBlock.subarray(entryStart, index).toString('utf-8');
      const eqIdx = entry.indexOf('=');
      if (eqIdx > 0) {
        envEntries[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
      }
    }

    entryStart = index + 1;
  }

  return envEntries;
}

function loadShellLaunchContext(
  userShell: string,
  requestedBin: string
): { resolvedBin: string; shellEnv?: Record<string, string> } {
  const shellBootstrapEnv: NodeJS.ProcessEnv = {};

  if (process.env.HOME) {
    shellBootstrapEnv.HOME = process.env.HOME;
  }
  shellBootstrapEnv.SHELL = userShell;
  shellBootstrapEnv.TERM = process.env.TERM || 'xterm-256color';

  const bootstrap = spawnSync(
    userShell,
    ['-l', '-i', '-c', SHELL_BOOTSTRAP_SCRIPT, 'ccsc', requestedBin],
    { env: shellBootstrapEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }
  );

  if (bootstrap.error) {
    throw bootstrap.error;
  }
  if (bootstrap.status !== 0) {
    throw new Error(bootstrap.stderr.toString('utf-8') || 'Failed to load shell environment');
  }

  const separatorIdx = bootstrap.stdout.indexOf(0);
  if (separatorIdx === -1) {
    return { resolvedBin: requestedBin };
  }

  const bootstrapPrelude = bootstrap.stdout
    .subarray(0, separatorIdx)
    .toString('utf-8')
    .trim();
  const resolvedCandidate = bootstrapPrelude
    .split(/\r?\n/)
    .find((line) => line.startsWith(RESOLVED_BIN_SENTINEL))
    ?.slice(RESOLVED_BIN_SENTINEL.length)
    .trim();
  const shellEnv = parseNullDelimitedEnv(bootstrap.stdout.subarray(separatorIdx + 1));

  return {
    resolvedBin: resolvedCandidate || requestedBin,
    shellEnv: Object.keys(shellEnv).length > 0 ? shellEnv : undefined,
  };
}

function suppressInkExitCursorRestore(): void {
  const showCursorEscape = '\u001B[?25h';
  const originalWrite = process.stderr.write.bind(process.stderr);

  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const text =
      typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf-8')
          : Buffer.from(chunk).toString('utf-8');

    if (text === showCursorEscape) {
      const callback = args.find((arg) => typeof arg === 'function') as
        | ((error?: Error | null) => void)
        | undefined;
      callback?.(undefined);
      return true;
    }

    return originalWrite(
      chunk as Parameters<typeof process.stderr.write>[0],
      ...(args as Parameters<typeof process.stderr.write> extends [unknown, ...infer Rest] ? Rest : never)
    );
  }) as typeof process.stderr.write;
}

async function main(claudeArgs: string[], cliOverride?: string): Promise<void> {
  if (!isDbAvailable()) {
    console.error('CC Switch database not found.');
    console.error(
      'Please ensure CC Switch is installed and has been run at least once.'
    );
    process.exit(1);
  }

  const providers = getProviders();

  if (providers.length === 0) {
    console.error('No Claude providers found in CC Switch.');
    console.error('Please add providers in CC Switch first.');
    process.exit(1);
  }

  // Sort by history
  const history = await loadHistory();
  const sortedProviders = sortByHistory(providers, history);

  // Let Ink own the selection lifecycle so terminal cleanup completes before
  // we hand stdio to the spawned CLI.
  const ink = render(
    React.createElement(App, {
      providers: sortedProviders,
    })
  );
  const selectedProvider = (await ink.waitUntilExit()) as Provider | undefined;

  if (!selectedProvider) {
    process.exit(0);
  }

  // Ink already restored the cursor during unmount. Suppress the duplicate
  // process-exit cursor restore hook from cli-cursor/restore-cursor, which can
  // trip shell job control (`stty tostop`) after we hand off to the real CLI.
  suppressInkExitCursorRestore();

  // Save to history
  await saveToHistory(selectedProvider.name);

  // Create provider-specific settings file with merged env
  const settingsPath = await createProviderSettings(
    selectedProvider.name,
    selectedProvider.envVars,
    selectedProvider.settingsConfig
  );

  // Build claude args with --settings parameter
  const finalArgs = [`--settings=${settingsPath}`, ...claudeArgs];

  // Spawn claude process
  console.log(`🚀 Starting Claude with provider: ${selectedProvider.name}`);

  // Priority: --cli option > CC_CLI_PATH env var > 'claude' default
  const claudeBin = cliOverride || process.env.CC_CLI_PATH || 'claude';

  // We must NOT hand terminal ownership directly to an interactive shell here
  // because Ink teardown and shell job control can conflict. Instead we:
  //   1. Resolve the binary path via a login shell (handles version managers)
  //   2. Capture the login shell's full environment
  //   3. On POSIX, hand off through a tiny non-interactive trampoline that
  //      reclaims the foreground tty before exec'ing the real CLI
  // This gives Claude's subprocesses (MCP servers, hooks) the same
  // shell-initialized PATH/tooling they'd get from `bash -i`, without the
  // interactive-shell process-group conflict.
  const userShell = process.env.SHELL;

  let resolvedBin = claudeBin;
  let shellEnv: Record<string, string> | undefined;

  if (userShell) {
    try {
      const launchContext = loadShellLaunchContext(userShell, claudeBin);
      resolvedBin = launchContext.resolvedBin;
      shellEnv = launchContext.shellEnv;
    } catch {
      // Fall through with current process environment
    }
  }

  // Build the child environment from the captured login-shell environment
  // so Claude and its subprocesses inherit the user's shell PATH/toolchain.
  // If the current process has extra runtime context (SSH agent, locale, CI
  // flags, etc.), preserve it as long as it does not override shell-sensitive
  // variables such as PATH or version-manager settings.
  const shellSensitiveEnvKeys = new Set([
    'PATH',
    'HOME',
    'SHELL',
    'NODE_PATH',
    'NODE_OPTIONS',
    'NVM_BIN',
    'NVM_DIR',
    'VOLTA_HOME',
    'ASDF_DIR',
    'PNPM_HOME',
  ]);
  const childEnv: Record<string, string | undefined> = shellEnv
    ? { ...shellEnv }
    : { ...process.env };

  if (shellEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (!shellSensitiveEnvKeys.has(key)) {
        childEnv[key] = value;
      }
    }
  }

  const child =
    process.platform === 'win32'
      ? spawn(resolvedBin, finalArgs, {
          stdio: 'inherit',
          env: childEnv,
          shell: true,
        })
      : spawn('sh', ['-c', POSIX_EXEC_TRAMPOLINE, 'ccsc', resolvedBin, ...finalArgs], {
          stdio: 'inherit',
          env: childEnv,
        });

  child.on('error', (err) => {
    console.error(`Failed to start ${claudeBin}:`, err.message);
    console.error('Please ensure Claude CLI is installed and in your PATH.');
    console.error('You can set CC_CLI_PATH environment variable or use --cli option to specify a custom CLI.');
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code || 0;
  });
}
