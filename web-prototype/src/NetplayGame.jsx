import {lazy, Suspense, useEffect, useMemo, useRef, useState} from 'react';
import {gameIdFromLocation, gameLink, joinGame, NetplaySession, readJson, forgetAccess} from '../shared/netplay-client.js';
import {meleeRoomAction, ssb64RoomUrl} from '../shared/netplay-launch.js';
import {hasStoredRom, storeRom, prewarmEngineArchive} from '../shared/rom-store.js';
import {identifyRomFile} from './rom-validation.js';
import './netplay.css';

const MeleeStreamGame = lazy(() => import("./MeleeStreamGame.jsx"));
const MeleeExperience = lazy(() => import('../../engines/melee/launcher/Experience.tsx'));

export default function NetplayGame() {
  const [session, setSession] = useState(null), [view, setView] = useState(null), [error, setError] = useState('');
  const [joining, setJoining] = useState(false), [romReady, setRomReady] = useState(false), [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false), [soundOn, setSoundOn] = useState(false);
  const [failedGuestAccess, setFailedGuestAccess] = useState(false);
  const connection = useRef(null), frame = useRef(null);
  let id;
  try { id = gameIdFromLocation(window.location); } catch (cause) { id = null; }
  useEffect(() => {
    hasStoredRom().then(setRomReady).catch(() => {});
    return () => { connection.current?.close(); if (window.openSmashNetplay === connection.current) delete window.openSmashNetplay; };
  }, []);
  async function join() {
    if (joining || connection.current) return;
    setJoining(true); setError(''); setFailedGuestAccess(false);
    try {
      if (typeof WebTransport !== 'function' || !window.isSecureContext) throw Error('Open this link over HTTPS in a browser with WebTransport support.');
      if (window.openSmashDesktop) throw Error('Open this game link in your web browser. Online play uses the browser engines.');
      const access = await joinGame(id);
      const next = new NetplaySession(access);
      connection.current = next;
      next.subscribe(setView);
      window.openSmashNetplay = next;
      setSession(next);
      await next.connect();
    } catch (cause) {
      setFailedGuestAccess(connection.current?.seat > 0 && connection.current?.room.state !== 'ended' && (connection.current?.room.state === 'lobby' || connection.current?.room.mode === 'host-stream'));
      connection.current?.close();
      if (window.openSmashNetplay === connection.current) delete window.openSmashNetplay;
      connection.current = null; setSession(null); setView(null);
      setError(cause.message);
    }
    finally { setJoining(false); }
  }
  async function chooseRom(event) {
    const file = event.target.files?.[0]; if (!file) return;
    setError('');
    try {
      const rom = await identifyRomFile(file, {onStatus: setStatus});
      await readJson(await fetch('/api/validate-rom', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({algorithm: 'SHA-1', hash: rom.sha1, size: rom.size})}));
      await storeRom(rom); setStatus('Preparing game assets…');
      await prewarmEngineArchive(); setRomReady(true); setStatus('');
    } catch (cause) { setError(cause.message); setStatus(''); }
  }
  const room = view?.room;
  const active = room && ['preparing', 'running'].includes(room.state) && !view.error;
  const frozenSeats = room?.players.map(player => player.seat).join(',');
  // Room status and audio updates must never restart a prepared game at tick 0.
  const game = useMemo(() => {
    if (!room) return null;
    if (room.mode === 'host-stream') return {};
    try { return room.engine === 'melee' ? {action: meleeRoomAction(room)} : {src: ssb64RoomUrl(room)}; }
    catch (cause) { return {error: cause.message}; }
  }, [room?.id, frozenSeats]);
  useEffect(() => { if (active && game?.error) session?.fail(Error(game.error)); }, [active, game, session]);
  const ready = room?.players.length > 0 && room.players.every(player => player.connected && player.ready);
  const link = room ? gameLink(window.location.origin, room.engine, room.id) : window.location.href;
  async function copy() { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setStatus('Select and copy the game link below.'); } }
  function leave() { if (session?.seat > 0) forgetAccess(id); session?.close(); window.location.assign(room?.engine === 'melee' ? '/melee' : '/'); }
  function rejoin() {
    forgetAccess(id); session?.close(); connection.current = null; delete window.openSmashNetplay;
    setSession(null); setView(null); setError(''); setFailedGuestAccess(false);
  }
  function command(method) { setError(''); session[method]().catch(cause => setError(cause.message)); }
  // Frame errors are emitted by the patched engine bridge. A preparation
  // failure must also end the session so the other players do not wait forever.
  useEffect(() => {
    const onMessage = event => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'opensmash:engine-asset-error') session?.fail(Error(event.data.message || 'Could not prepare Smash 64.'));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session]);
  useEffect(() => {
    if (!active || room.engine !== 'ssb64') return;
    const update = () => {
      const audio = frame.current?.contentWindow?.Module?.SDL2?.audioContext;
      if (audio) (soundOn && !document.hidden ? audio.resume() : audio.suspend()).catch(() => {});
    };
    update(); const timer = setInterval(update, 500);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [active, room?.engine, soundOn]);
  let engineContent = null;
  if (active && room.mode !== 'host-stream') {
    try {
      if (game.error) throw Error(game.error);
      engineContent = room.engine === 'melee'
        ? <Suspense fallback={<p role="status">Loading Melee…</p>}><MeleeExperience action={game.action} onClose={leave} soundOn={soundOn}/></Suspense>
        : romReady ? <iframe ref={frame} src={game.src} title="Online Smash 64 match" allow="autoplay; gamepad; fullscreen"/>
        : <section className="netplay-disc"><h2>Choose your Smash 64 ROM</h2><p>Each player supplies their own US 1.0 ROM. Game files stay on your device.</p>
            <input aria-label="Smash 64 ROM" type="file" accept=".z64,.n64,.v64,.zip" onChange={chooseRom}/></section>;
    } catch (cause) { engineContent = <p role="alert">{cause.message}</p>; }
  }
  if (room?.mode === "host-stream") return <Suspense fallback={<main>Loading game stream…</main>}><MeleeStreamGame session={session} view={view} onLeave={leave} onRejoin={rejoin}/></Suspense>;
  return <main className="netplay-page">
    <header className="netplay-header"><a href="/">OpenSmash</a><span>Play together</span><button onClick={leave}>Leave game</button></header>
    <section className="netplay-room" aria-labelledby="room-title">
      <div><p className="netplay-eyebrow">{room ? room.engine === 'melee' ? 'Melee' : 'Smash 64' : 'Game invitation'}</p>
        <h1 id="room-title">{view?.started ? 'Game in progress' : 'Your game, your friends.'}</h1>
        <p>{room?.state === 'lobby' ? 'Share the link, then prepare when everyone has joined. Up to four players.'
          : room?.state === 'preparing' ? 'Preparing the same match on every device. Each player needs their own game files.'
          : view?.started ? `You are Player ${view.seat + 1}. Use a connected controller or the keyboard.`
          : 'Join this game to take a player slot.'}</p>
      </div>
      {!session && <button className="netplay-primary" disabled={joining || !id} onClick={join}>{joining ? 'Connecting…' : 'Join game'}</button>}
      {!session && failedGuestAccess && <button onClick={() => {
        forgetAccess(id); setFailedGuestAccess(false); setError('');
      }}>Clear old player slot and rejoin</button>}
      {!id && <p role="alert">This game link is invalid.</p>}
      {room && <>
        <div className="netplay-share"><input aria-label="Game invitation link" readOnly value={link} onFocus={event => event.target.select()}/><button onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button></div>
        <ol className="netplay-players">{Array.from({length: 4}, (_, seat) => {
          const player = room.players.find(player => player.seat === seat);
          return <li key={seat} data-occupied={Boolean(player)}><strong>Player {seat + 1}{seat === view.seat ? ' · You' : ''}</strong><span>{!player ? room.state === 'lobby' ? 'Open slot' : 'CPU'
            : !player.connected ? 'Connecting' : player.ready ? 'Ready' : room.state === 'lobby' ? 'Joined' : 'Preparing'}</span></li>;
        })}</ol>
        {view.seat === 0 && room.state === 'lobby' && <button className="netplay-primary" disabled={!room.players.every(p => p.connected)} onClick={() => command('prepare')}>Prepare game</button>}
        {view.seat === 0 && room.state === 'preparing' && <button className="netplay-primary" disabled={!ready} onClick={() => command('start')}>{ready ? 'Start game' : 'Waiting for players…'}</button>}
        {view.seat !== 0 && !view.started && <p role="status">{ready ? 'Waiting for the host to start.' : room.state === 'lobby' ? 'Waiting for the host to prepare the game.' : 'Loading game files…'}</p>}
      </>}
      {(error || view?.error) && <p role="alert" className="netplay-error">{error || view.error}</p>}
      {view?.error && room?.state === 'lobby' && view.seat !== 0 && <button onClick={() => {
        forgetAccess(id); session.close(); connection.current = null; delete window.openSmashNetplay;
        setSession(null); setView(null); setError('');
      }}>Rejoin lobby</button>}
      {status && <p role="status">{status}</p>}
    </section>
    {active && <section className="netplay-engine" aria-label="Game"><div className="netplay-engine-tools"><button onClick={() => setSoundOn(!soundOn)}>{soundOn ? 'Mute' : 'Enable sound'}</button>
      <button onClick={() => { const target = frame.current || document.querySelector('.netplay-engine canvas'); target?.requestFullscreen?.(); }}>Fullscreen</button></div>{engineContent}</section>}
    <footer>Every new game has a new link. Players join before preparation; a disconnect ends the match.</footer>
  </main>;
}
