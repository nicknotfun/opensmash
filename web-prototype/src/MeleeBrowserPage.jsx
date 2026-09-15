import {useEffect, useState} from 'react';
import {createGame, gameLink, readJson} from '../shared/netplay-client.js';
import './netplay.css';

export default function MeleeBrowserPage() {
  const [runtime, setRuntime] = useState(null), [error, setError] = useState(''), [creating, setCreating] = useState(false);
  useEffect(() => { const abort = new AbortController();
    fetch('/api/melee/browser', {signal: abort.signal, cache: 'no-store'}).then(readJson).then(setRuntime).catch(error => {if (!abort.signal.aborted) setError(error.message);});
    return () => abort.abort();
  }, []);
  async function create() {
    if (creating) return;
    setCreating(true); setError('');
    try {
      if (!window.isSecureContext || typeof WebTransport !== 'function' || typeof RTCPeerConnection !== 'function') throw Error('Use a browser with WebTransport and WebRTC support over HTTPS.');
      if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') throw Error('The host browser needs shared memory. Reload this page to check browser isolation.');
      const access = await createGame('melee', {seed: crypto.getRandomValues(new Uint32Array(1))[0]}, {mode: 'host-stream'});
      window.location.assign(gameLink(location.origin, 'melee', access.room.id));
    } catch (error) {setError(error.message); setCreating(false);}
  }
  return <main className="netplay-page">
    <header className="netplay-header"><a href="/">OpenSmash</a><span>Melee</span></header>
    <section className="netplay-room">
      <p className="netplay-eyebrow">Browser hosting · Preview</p>
      <h1>Your game. One link.</h1>
      <p>Run Melee in your browser using your local USA 1.02 ISO. Share a fresh game link with up to three friends. They play through your video and audio stream using their keyboard or controller.</p>
      <p>Your ISO stays on your device. Keep the host tab open while playing. Start with the original Melee roster; streaming performance depends on your computer and connection.</p>
      <button className="netplay-primary" onClick={create} disabled={!runtime?.available || creating}>{creating ? 'Creating game…' : 'Host a Melee game'}</button>
      {!runtime && !error && <p role="status">Checking the browser engine…</p>}
      {runtime && !runtime.available && <p role="status">The browser engine is being prepared. Hosting will be available here when it is ready.</p>}
      {error && <p role="alert" className="netplay-error">{error}</p>}
    </section>
    <footer>Each game has a unique link. Guests join in their browsers. The game ends when the host leaves.</footer>
  </main>;
}
