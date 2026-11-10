import { spawn } from 'node:child_process';

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  maxOutputBytes?: number;
  /** Called for every complete stdout line as it arrives; `stop()` kills the command. */
  onStdoutLine?: (line: string, stop: () => void) => void;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a command without a shell, so message text in arguments is never interpreted.
 * Rejects only when the command cannot be started; a non-zero exit resolves normally.
 */
export function runProcess(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { input = '', timeoutMs = 60_000, env, cwd, maxOutputBytes = 16 * 1024 * 1024, onStdoutLine } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) {
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));

    if (onStdoutLine !== undefined) {
      const stop = () => child.kill('SIGKILL');
      let partial = '';
      child.stdout.on('data', (chunk: Buffer) => {
        const lines = (partial + chunk.toString('utf8')).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) onStdoutLine(line, stop);
      });
      child.stdout.on('end', () => {
        if (partial !== '') onStdoutLine(partial, stop);
      });
    }

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    });

    // The child may exit before reading its input.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
