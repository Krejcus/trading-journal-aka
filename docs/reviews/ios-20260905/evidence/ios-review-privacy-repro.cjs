const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { transformSync } = require('/Users/filipkrejca/Documents/trading-journal-aka/node_modules/esbuild');

// Execute the unmodified React component with a deterministic hook scheduler.
// Native overlay transitions below correspond to SceneDelegate + PrivacyShield.
const source = fs.readFileSync('/Users/filipkrejca/Documents/trading-journal-aka/components/NativePrivacyGate.tsx', 'utf8');
const compiled = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;

async function scenario(authSuccess) {
  let slots = [], index = 0, effects = [], scheduled = false, component, tree;
  let nativeShield = false, authenticationCalls = 0;
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const window = new EventTarget();
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; render(); });
  };
  const react = {
    createElement: (type, props, ...children) => ({type, props, children}),
    useState(value) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = value;
      return [slots[slot], next => {
        const value = typeof next === 'function' ? next(slots[slot]) : next;
        if (!Object.is(slots[slot], value)) { slots[slot] = value; schedule(); }
      }];
    },
    useRef(value) {
      const slot = index++;
      return slots[slot] ||= {current: value};
    },
    useCallback(fn, deps) {
      const slot = index++;
      if (!slots[slot] || !equalDeps(slots[slot].deps, deps)) slots[slot] = {fn, deps};
      return slots[slot].fn;
    },
    useEffect(fn, deps) {
      const slot = index++;
      if (!slots[slot] || !equalDeps(slots[slot].deps, deps)) {
        const previous = slots[slot];
        slots[slot] = {deps};
        effects.push(() => { previous?.cleanup?.(); slots[slot].cleanup = fn(); });
      }
    },
  };
  const module = {exports: {}};
  vm.runInNewContext(compiled, {
    module, exports: module.exports, window, document,
    require(name) {
      if (name === 'react') return react;
      if (name === 'lucide-react') return {LockKeyhole: 'icon'};
      if (name.endsWith('/runtimeConfig')) return {isNativeBuild: true};
      if (name.endsWith('/nativeCapabilities')) return {
        getNativePrivacyEnabled: async () => true,
        authenticateNativePrivacy: async () => {authenticationCalls++; nativeShield = false; return authSuccess;},
      };
      throw new Error(name);
    },
  });
  component = module.exports.default;
  const render = () => { index = 0; tree = component(); const pending = effects; effects = []; pending.forEach(fn => fn()); };
  const settle = async () => {for(let i=0; i<30; i++) await Promise.resolve();};
  render();
  await settle();
  const afterFirstAttempt = {authenticationCalls, reactLocked: tree !== null, nativeShield};
  // App enters background: sceneWillResignActive -> showIfEnabled.
  nativeShield = true;
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  // Return to foreground: refreshScreenCaptureState retains .privacyLock.
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  return {afterFirstAttempt, afterResume: {authenticationCalls, reactLocked: tree !== null, nativeShield}};
}

(async () => {
  const cancelled = await scenario(false);
  const succeeded = await scenario(true);
  assert.equal(cancelled.afterFirstAttempt.authenticationCalls, 1);
  assert.deepEqual(cancelled.afterResume, {authenticationCalls: 1, reactLocked: true, nativeShield: true});
  assert.deepEqual(succeeded.afterResume, {authenticationCalls: 2, reactLocked: false, nativeShield: false});
  console.log(JSON.stringify({cancelled, succeeded}, null, 2));
})();
