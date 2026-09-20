// Run the native capture-consent policy on macOS without an iOS Simulator.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../../capacitor-ios/App/App/AlphaTradeNativePlugin.swift', import.meta.url), 'utf8');
const policy = source.match(/struct AlphaTradeCapturePreviewSession \{[\s\S]*?\n\}(?=\n#endif)/)?.[0];
if (!policy) throw new Error('Native capture preview policy was not found');
const directory = mkdtempSync(join(tmpdir(), 'alphatrade-capture-preview-'));
try {
  const path = join(directory, 'main.swift');
  writeFileSync(path, `import Foundation\n${policy}\nvar session = AlphaTradeCapturePreviewSession()
assert(session.shouldObscure(isCaptured: true, now: 1000), "Capture must be blocked by default")
assert(!session.shouldObscure(isCaptured: false, now: 1000), "No capture must not obscure")
session.allow(now: 1000)
assert(!session.shouldObscure(isCaptured: true, now: 1001), "Explicit consent must allow preview")
assert(!session.shouldObscure(isCaptured: true, now: 1899.999), "Preview must last 15 minutes")
assert(session.shouldObscure(isCaptured: true, now: 1900), "Exact deadline must re-protect")
assert(session.shouldObscure(isCaptured: true, now: 1901), "Expired consent must stay revoked")
session.allow(now: 2000)
assert(!session.shouldObscure(isCaptured: false, now: 2001), "Disconnect must clear preview")
assert(session.shouldObscure(isCaptured: true, now: 2002), "Reconnect must require new consent")
session.allow(now: 3000)
session = AlphaTradeCapturePreviewSession()
assert(session.shouldObscure(isCaptured: true, now: 3001), "Relaunch or timer reset must revoke consent")
session.allow(now: 4000)
assert(session.shouldObscure(isCaptured: true, now: 6000), "Resume after expiry must re-protect")
print("Capture preview: 10 lifecycle assertions passed")
`);
  const result = spawnSync('xcrun', ['swift', '-module-cache-path', join(directory, 'cache'), path], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
