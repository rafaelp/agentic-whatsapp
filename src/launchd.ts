import { homedir } from 'node:os';
import { join } from 'node:path';

export const LAUNCHD_LABEL = 'agentic-whatsapp';

export interface LaunchdOptions {
  node: string;
  script: string;
  configFile: string;
  path: string;
  logFile?: string;
}

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A launchd agent that keeps `agentic-whatsapp run` alive. PATH is copied from the
 * current shell because launchd starts jobs with a minimal one, where `agy` and
 * `wacli` are usually not found.
 */
export function launchdPlist(options: LaunchdOptions): string {
  const logFile = options.logFile ?? join(homedir(), 'Library', 'Logs', 'agentic-whatsapp.log');
  const args = [options.node, options.script, 'run', '--config', options.configFile];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(options.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
}
