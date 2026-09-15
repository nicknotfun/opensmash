import {createBrowserHost} from '/melee-browser-host-runtime.js';

const status = document.getElementById('status');
try {
  if (window.parent === window || !crossOriginIsolated || typeof SharedArrayBuffer !== 'function') throw Error('Open this game from its OpenSmash room in a browser with shared memory support.');
  // Fixed runtime profile. Invitation query parameters never enable upstream
  // debug, external core, demo, checkpoint or experimental renderer options.
  history.replaceState(null, '', location.pathname + '?cpu=dual&wasmjit=1&fastsw=1&pacing=direct');
  const [{EmulatorHost}, {AudioController}] = await Promise.all([
    import('/melee/browser-runtime/src/core-host.js'), import('/melee/browser-runtime/src/audio.js'),
  ]);
  const host = createBrowserHost({EmulatorHost, AudioController, canvas: document.getElementById('game'), onVideoReady: () => {status.hidden = true;}});
  window.openSmashBrowserHost = host;
  parent.postMessage({type: 'opensmash:melee-host-ready'}, location.origin);
  addEventListener('pagehide', () => host.stop(), {once: true});
} catch (error) {status.textContent = error.message; parent.postMessage({type: 'opensmash:melee-host-error', message: error.message}, location.origin);}
