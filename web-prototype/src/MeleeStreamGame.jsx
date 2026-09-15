import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {HostStream} from '../shared/host-stream.js';
import {gameLink, NEUTRAL_PAD, readJson} from '../shared/netplay-client.js';
import {inspectDisc} from '../../engines/melee/runtime/web/disc.mjs';
import {loadBindings, rawGamepads, sampleMeleePad, keyLabel} from '../../engines/melee/web/lib/controls';

const BUTTONS = {a:0x100,b:0x200,x:0x400,y:0x800,z:0x10,l:0x40,r:0x20,start:0x1000};
export default function MeleeStreamGame({session, view, onLeave, onRejoin}) {
  const host = session.seat === 0, {room} = view;
  const frame = useRef(null), video = useRef(null), engine = useRef(null), peers = useRef(null), alive = useRef(true);
  const loadAttempt = useRef(0), choosingDisc = useRef(false), soundPreference = useRef(true);
  const [media, setMedia] = useState(null), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false), [frameReady, setFrameReady] = useState(false), [sound, setSound] = useState(true);
  const [copied, setCopied] = useState(false), [connections, setConnections] = useState({});
  const [playing, setPlaying] = useState(false), [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const self = room.players.find(p => p.seat === session.seat);
  const link = gameLink(location.origin, 'melee', room.id);
  const bindings = loadBindings();
  // Stop the iframe runtime before React removes its browsing context.
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; loadAttempt.current++; engine.current?.stop(); engine.current = null; peers.current?.close(); };
  }, []);
  useEffect(() => {
    if (!host) return;
    const receive = event => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'opensmash:melee-host-ready') {
        const runtime = frame.current.contentWindow.openSmashBrowserHost;
        setFrameReady(Boolean(runtime && ['load','setPad','setMuted','stop'].every(name => typeof runtime[name] === 'function')));
      } else if (event.data?.type === 'opensmash:melee-host-error') {
        setFrameReady(false); setError(String(event.data.message || 'The browser engine could not load.').slice(0,1024));
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [host]);
  useEffect(() => { soundPreference.current = sound; engine.current?.setMuted(!sound); }, [sound]);
  useEffect(() => {
    if (!view.error && view.connected) return;
    loadAttempt.current++; engine.current?.stop(); engine.current = null; peers.current?.close();
    setMedia(null); setLoading(false);
  }, [view.error, view.connected]);
  useEffect(() => {
    if (!view.connected || !self?.connected || !self.generation || (host && !media) || view.error) return;
    let closed = false, connection, offSignals, offRoom;
    const abort = new AbortController();
    const generations = new Map();
    (async () => {
      const ice = await readJson(await fetch('/api/netplay/ice', {method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({room: room.id, token: session.token}), signal: abort.signal}));
      if (closed) return;
      connection = new HostStream({seat: session.seat, stream: host ? media : undefined, iceServers: ice.iceServers,
        sendSignal: (to, signal) => session.signal(to, signal),
        onPad: (seat, pad) => {if (!closed) engine.current?.setPad(seat, pad);},
        onStream: stream => {
          const element = video.current;
          if (closed || !element || element.srcObject === stream) return;
          element.srcObject = stream;
          element.play().then(() => {if (!closed) setPlaying(true);}).catch(() => {if (!closed) setPlaying(false);});
        },
        onState: ({seat, state}) => {
          if (closed) return;
          setConnections(previous => ({...previous, [seat]: state}));
          if (['closed','disconnected'].includes(state)) {
            if (host) engine.current?.setPad(seat, NEUTRAL_PAD, false);
            else setPlaying(false);
          }
        },
        onError: error => {if (!closed) setError(error.message);},
      });
      peers.current = connection;
      offSignals = session.subscribeSignals(message => {connection.receiveSignal(message).catch(error => {if (!closed) setError(error.message);});});
      offRoom = session.subscribe(snapshot => {
        if (closed) return;
        if (snapshot.error || !snapshot.connected) {connection.close(); return;}
        const members = snapshot.room.players.filter(p => p.connected && p.seat !== session.seat && (host || p.seat === 0));
        for (const seat of generations.keys()) if (!members.some(p => p.seat === seat)) {connection.removePeer(seat); generations.delete(seat); if (host) engine.current?.setPad(seat, NEUTRAL_PAD, false);}
        for (const player of members) {
          if (generations.get(player.seat) === player.generation) continue;
          if (generations.has(player.seat)) connection.removePeer(player.seat);
          generations.set(player.seat, player.generation);
          if (host) connection.connectGuest(player.seat).catch(error => {if (!closed) setError(error.message);});
        }
      });
      setStatus(ice.relay ? '' : 'Connecting directly. Some networks may need a relay connection.');
    })().catch(error => {if (!closed) setError(error.message);});
    return () => {
      closed = true; abort.abort(); offSignals?.(); offRoom?.(); connection?.close();
      if (host) for (const seat of generations.keys()) engine.current?.setPad(seat, NEUTRAL_PAD, false);
      if (peers.current === connection) peers.current = null;
      if (!host && video.current) {video.current.srcObject = null; setPlaying(false);}
    };
  }, [session, self?.connected, self?.generation, view.connected, Boolean(view.error), host, media]);

  useEffect(() => {
    if (view.error || !view.connected) return;
    const keys = new Set(), kb = bindings.keyboard;
    // The iframe has its own HTMLElement constructor; use its DOM interface.
    const editable = target => target?.nodeType === 1 && target.matches('input,textarea,select,[contenteditable=true]');
    const child = host && frameReady ? frame.current?.contentWindow : null;
    const activeElement = () => document.activeElement === frame.current ? child?.document.activeElement : document.activeElement;
    const bound = new Set(Object.values(kb));
    const sample = () => {
      let pad = [...NEUTRAL_PAD];
      if (document.hasFocus() && !document.hidden && !editable(activeElement())) {
        for (const [action, bit] of Object.entries(BUTTONS)) if (keys.has(kb[action])) pad[0] |= bit;
        pad[1] = ((keys.has(kb.right)?1:0)-(keys.has(kb.left)?1:0))*100;
        pad[2] = ((keys.has(kb.up)?1:0)-(keys.has(kb.down)?1:0))*100;
        pad[3] = ((keys.has(kb.cright)?1:0)-(keys.has(kb.cleft)?1:0))*100;
        pad[4] = ((keys.has(kb.cup)?1:0)-(keys.has(kb.cdown)?1:0))*100;
        const device = rawGamepads().find(p => p?.connected);
        if (device) {
          const gamepad = sampleMeleePad(device); pad[0] |= gamepad[2];
          for (let i=1;i<7;i++) if (Math.abs(gamepad[i+2]) > Math.abs(pad[i])) pad[i] = gamepad[i+2];
        }
      }
      if (host) engine.current?.setPad(0, pad); else peers.current?.sendPad(pad);
    };
    const clear = () => {keys.clear(); if (host) engine.current?.setPad(0, NEUTRAL_PAD); else peers.current?.sendPad([...NEUTRAL_PAD]);};
    const down = event => {if (!editable(event.target) && bound.has(event.code) && !event.metaKey && !event.ctrlKey && !event.altKey) {event.preventDefault(); keys.add(event.code); sample();}};
    const up = event => {keys.delete(event.code); sample();};
    const targets = child ? [window, child] : [window];
    for (const target of targets) {target.addEventListener('keydown', down, true); target.addEventListener('keyup', up, true); target.addEventListener('blur', clear);}
    document.addEventListener('visibilitychange', clear);
    // Sampling runs independently of video playback and emulator stepping.
    const timer = setInterval(sample, 1000 / 60);
    return () => {
      clearInterval(timer);
      for (const target of targets) {target.removeEventListener('keydown',down,true); target.removeEventListener('keyup',up,true); target.removeEventListener('blur',clear);}
      document.removeEventListener('visibilitychange',clear); clear();
    };
  }, [host, view.connected, Boolean(view.error), bindings, frameReady]);

  async function chooseDisc(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!host || !file || choosingDisc.current || !view.connected || view.error) return;
    choosingDisc.current = true;
    const attempt = ++loadAttempt.current;
    const current = () => alive.current && attempt === loadAttempt.current && !session.closed;
    let runtime;
    setLoading(true); setError(''); setStatus('Checking your local Melee ISO…');
    try {
      await inspectDisc(file);
      if (!current()) return;
      runtime = frame.current?.contentWindow?.openSmashBrowserHost;
      if (!runtime) throw Error('The browser engine has not loaded. Reload the game to try again.');
      engine.current = runtime;
      const stream = await runtime.load(file, message => {if (current()) setStatus(message);});
      if (!current()) {runtime.stop(); return;}
      runtime.setMuted(!soundPreference.current);
      if (session.room.state === 'lobby') await session.prepare();
      if (!current()) {runtime.stop(); return;}
      if (session.room.state !== 'running') {await session.ready(); await session.start();}
      if (!current()) {runtime.stop(); return;}
      setMedia(stream);
      setStatus('Host running. Choose fighters and a stage using Melee’s menus.');
    } catch (error) {
      runtime?.stop();
      if (current()) {setError(error.message); setMedia(null); if (engine.current === runtime) engine.current = null;}
    } finally {
      choosingDisc.current = false;
      if (current()) setLoading(false);
    }
  }
  function reloadRuntime() {
    loadAttempt.current++; engine.current?.stop(); engine.current = null; peers.current?.close();
    setMedia(null); setFrameReady(false); setError(''); setStatus('');
    setRuntimeAttempt(previous => previous + 1);
  }
  function reconnectGuests() {
    setError('');
    for (const player of session.room.players) if (player.connected && player.seat !== 0) {
      peers.current?.connectGuest(player.seat).catch(error => {if (alive.current) setError(error.message);});
    }
  }
  async function copy() {try {await navigator.clipboard.writeText(link); setCopied(true);} catch {setError('Select and copy the invitation link.');}}
  function mute() {setSound(previous => !previous);}
  return <main className="netplay-page">
    <header className="netplay-header"><a href="/">OpenSmash</a><span>Melee · Browser hosting</span><button onClick={onLeave}>Leave game</button></header>
    <section className="netplay-room">
      <p className="netplay-eyebrow">Player {session.seat + 1}{host ? ' · Host' : ''}</p>
      <h1>{host ? 'Share your game.' : 'Play with your friends.'}</h1>
      <p>{host ? 'Choose your local USA 1.02 ISO, then keep this tab open. Friends join through your stream.' : 'Your host runs Melee. Your keyboard or controller sends inputs to your assigned player.'}</p>
      <div className="netplay-share"><input aria-label="Game invitation link" readOnly value={link} onFocus={e=>e.target.select()}/><button onClick={copy}>{copied?'Copied':'Copy link'}</button></div>
      <ol className="netplay-players">{Array.from({length:4},(_,seat)=>{const player=room.players.find(p=>p.seat===seat);return <li key={seat} data-occupied={Boolean(player)}><strong>Player {seat+1}{seat===session.seat?' · You':''}</strong><span>{!player?'Open slot':!player.connected?'Disconnected':seat===session.seat?'Joined':connections[seat]||'Joined'}</span></li>;})}</ol>
      {host && !media && <section className="netplay-disc"><label>Melee ISO <input aria-label="Melee ISO" type="file" accept=".iso,.gcm" disabled={!frameReady||loading||Boolean(view.error)} onChange={chooseDisc}/></label><p>Your ISO is read locally and stays on this device.</p></section>}
      {(error||view.error)&&<p role="alert" className="netplay-error">{error||view.error}</p>}
      {host&&error&&!view.error&&!media&&!loading&&<button onClick={reloadRuntime}>Reload local engine</button>}
      {!host&&view.error&&room.state!=='ended'&&<button onClick={onRejoin}>Clear old player slot and rejoin</button>}
      {status&&<p role="status">{status}</p>}
      {!host&&!playing&&<p role="status">{view.started?'Connecting to the host’s stream…':'Waiting for the host to choose their ISO.'}</p>}
    </section>
    <section className="netplay-engine" aria-label="Melee game">
      <div className="netplay-engine-tools"><button onClick={mute}>{sound?'Mute':'Enable sound'}</button><button onClick={()=>{(host?frame.current:video.current)?.requestFullscreen?.();}}>Fullscreen</button>{host&&media&&<button onClick={reconnectGuests} disabled={!view.connected||Boolean(view.error)}>Reconnect guests</button>}</div>
      {host?<iframe key={runtimeAttempt} ref={frame} src="/melee/browser-runtime/index.html" title="Local Melee emulator" allow="autoplay; gamepad; fullscreen" onLoad={()=>setFrameReady(Boolean(frame.current?.contentWindow?.openSmashBrowserHost))}/>
        :<video ref={video} autoPlay playsInline muted={!sound} controls onPlaying={()=>setPlaying(true)} aria-label="Host’s Melee stream"/>}
      {!host&&!playing&&<button onClick={()=>video.current?.play().then(()=>setPlaying(true)).catch(error=>setError(error.message))}>Play stream</button>}
      <p>Click the game picture to use keyboard controls. Move: {[bindings.keyboard.up,bindings.keyboard.left,bindings.keyboard.down,bindings.keyboard.right].map(keyLabel).join(' ')} · Attack: {keyLabel(bindings.keyboard.a)} · Special: {keyLabel(bindings.keyboard.b)} · Jump: {keyLabel(bindings.keyboard.x)} · Start: {keyLabel(bindings.keyboard.start)}</p>
    </section>
    <footer>Browser preview with the original Melee roster. Guest latency and game speed depend on the host computer and network. Host departure ends this game.</footer>
  </main>;
}
