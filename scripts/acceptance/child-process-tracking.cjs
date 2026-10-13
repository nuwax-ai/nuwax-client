'use strict';

const { promisify } = require('node:util');

/** Instrument a test process without changing Node callback/promise contracts. */
function installChildProcessTracking(childProcess, { onChild, isClosing }) {
  const methods = ['spawn', 'execFile', 'exec', 'fork'];
  const originals = Object.fromEntries(methods.map(method => [method, childProcess[method]]));
  const seen = new WeakSet();
  const track = (child, method, args) => {
    if (child && !seen.has(child)) { seen.add(child); onChild(child, method, args); }
  };
  const assertOpen = () => {
    if (isClosing()) throw Error('Packaged capture test is shutting down; new child processes are disabled');
  };
  for (const method of methods) {
    const original = originals[method];
    const wrapper = function (...args) {
      assertOpen();
      const child = Reflect.apply(original, this, args);
      track(child, method, args);
      return child;
    };
    const descriptors = Object.getOwnPropertyDescriptors(original);
    const custom = descriptors[promisify.custom];
    if (typeof custom?.value === 'function') {
      const customWrapper = function (...args) {
        assertOpen();
        // Keep the original Promise (including .child) and {stdout,stderr}
        // resolution/rejection contract. Generic promisify would lose stderr.
        const promise = Reflect.apply(custom.value, this, args);
        track(promise.child, method, args);
        return promise;
      };
      descriptors[promisify.custom] = { ...custom, value: customWrapper };
    }
    Object.defineProperties(wrapper, descriptors);
    childProcess[method] = wrapper;
  }
  return { originals, restore() { for (const method of methods) childProcess[method] = originals[method]; } };
}

module.exports = { installChildProcessTracking };
