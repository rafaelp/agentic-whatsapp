import { describe, expect, it } from 'vitest';
import { LAUNCHD_LABEL, launchdPlist } from '../src/launchd.js';

describe('launchdPlist', () => {
  it('runs the agent with the current PATH and keeps it alive', () => {
    const plist = launchdPlist({
      node: '/opt/node/bin/node',
      script: '/opt/agentic-whatsapp/dist/cli.js',
      configFile: '/Users/me/.config/agentic-whatsapp/config.toml',
      path: '/opt/homebrew/bin:/usr/bin',
      logFile: '/Users/me/Library/Logs/agentic-whatsapp.log',
    });
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain(
      [
        '    <string>/opt/node/bin/node</string>',
        '    <string>/opt/agentic-whatsapp/dist/cli.js</string>',
        '    <string>run</string>',
        '    <string>--config</string>',
        '    <string>/Users/me/.config/agentic-whatsapp/config.toml</string>',
      ].join('\n'),
    );
    expect(plist).toContain('<string>/opt/homebrew/bin:/usr/bin</string>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
  });

  it('escapes XML in paths', () => {
    const plist = launchdPlist({ node: '/a&b/node', script: '/<x>.js', configFile: '/c', path: '/p', logFile: '/l' });
    expect(plist).toContain('/a&amp;b/node');
    expect(plist).toContain('/&lt;x&gt;.js');
  });
});
