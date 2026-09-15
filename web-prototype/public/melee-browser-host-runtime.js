// Adapter around a generic browser emulator. File objects go only to its worker.
const MAPPING = [[0x100,1],[0x200,2],[0x400,4],[0x800,8],[0x1000,16],[0x40,32],[0x20,64],[0x10,128],[8,256],[4,512],[1,1024],[2,2048]];
export function dolphinPad(pad, connected = true) {
  if (!Array.isArray(pad) || pad.length !== 7 || !pad.every(Number.isInteger) || pad[0] < 0 || pad[0] > 65535
      || !pad.slice(1,5).every(value => value >= -128 && value <= 127) || !pad.slice(5).every(value => value >= 0 && value <= 255)) throw Error('Invalid controller state.');
  let mask = 0; for (const [gamecube, dolphin] of MAPPING) if (pad[0] & gamecube) mask |= dolphin;
  return {connected: Boolean(connected), mask, stickX: pad[1]+128, stickY: pad[2]+128,
    cStickX: pad[3]+128, cStickY: pad[4]+128, triggerLeft: pad[5], triggerRight: pad[6],
    analogA: pad[0]&0x100 ? 255 : 0, analogB: pad[0]&0x200 ? 255 : 0};
}

export function createBrowserHost({EmulatorHost, AudioController, canvas, onVideoReady = () => {}, timeout = 120000}) {
  let emulator, audio, stream, localGain, stopError, started = false, stopped = false, cancelBoot, timer;
  function releaseResources() {
    try {emulator?.pause();} catch {}
    try {emulator?.adapter?.worker?.terminate();} catch {}
    emulator?.adapter?.rejectAll?.('The local game was closed.');
    try {audio?.stopPump(); audio?.workletNode?.disconnect(); audio?.gain?.disconnect(); localGain?.disconnect();} catch {}
    for (const track of stream?.getTracks() || []) track.stop();
    if (audio?.context?.state !== 'closed') void audio?.context?.close().catch(() => {});
  }
  function stop() {
    if (stopped) return;
    stopped = true; clearTimeout(timer); cancelBoot?.(Error('The local game was closed.'));
    releaseResources();
  }
  return {
    async load(file, onStatus = () => {}) {
      if (started || stopped) throw Error('Reload the room to start a fresh local game.');
      if (!file || typeof file.slice !== 'function') throw Error('Choose a local ISO.');
      started = true;
      const deadline = new Promise((_, reject) => {cancelBoot = reject; timer = setTimeout(() => reject(Error('Melee did not produce game frames in time. Reload the room to try again.')), timeout);});
      const boot = async () => {try {
        onStatus('Loading the browser engine…');
        audio = new AudioController();
        // Create/resume audio while the file-picker user action is recent.
        await audio.ensureContext();
        if (stopped) throw Error('The local game was closed.');
        if (!audio.context || !audio.gain) throw Error('Game audio is unavailable in this browser.');
        let firstFrame, firstTicks, firstPresented, progress;
        const advancing = new Promise(resolve => {progress = resolve;});
        emulator = new EmulatorHost({canvas, onStatus: message => {stopError = String(message);}, onFrame: frame => {
          if (frame.mode !== 'dolphin') return;
          firstFrame ??= frame.frame; firstTicks ??= frame.coreTicks; firstPresented ??= frame.presentedFrame;
          // CPU progress alone cannot establish a working video presenter.
          if (frame.frame > firstFrame && frame.coreTicks > firstTicks && frame.presentedFrame > firstPresented) progress();
        }});
        // Deliberately skip upstream's demonstration initialization/fallback UI.
        const game = await emulator.mountFile(file);
        if (stopped) throw Error('The local game was closed.');
        if (emulator.mode !== 'dolphin' || !game.fullCore || !game.coreBoot?.accepted) {
          throw Error('Melee could not boot from this ISO.' + (stopError ? ` ${stopError}` : ''));
        }
        onStatus('Starting your local Melee game…');
        audio.setSource(frames => emulator.mixAudio(frames));
        audio.setTransportBridge(config => emulator.configureAudioWorklet(config));
        // Guest audio stays active when the host mutes their own speakers.
        const destination = audio.context.createMediaStreamDestination();
        localGain = audio.context.createGain();
        audio.gain.disconnect(); audio.gain.connect(destination); audio.gain.connect(localGain); localGain.connect(audio.context.destination);
        await audio.setMuted(false);
        if (stopped) throw Error('The local game was closed.');
        emulator.start();
        await advancing;
        if (stopped) throw Error('The local game was closed.');
        // Capture after any OffscreenCanvas transfer, never before engine load.
        stream = canvas.captureStream(60);
        for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
        onVideoReady();
        return stream;
      } finally {if (stopped) releaseResources();}};
      try {const result = await Promise.race([boot(), deadline]); clearTimeout(timer); cancelBoot = null; return result;}
      catch (error) {stop(); throw error;}
    },
    setPad(seat, pad, connected = true) {
      if (!Number.isInteger(seat) || seat < 0 || seat > 3) throw Error('Invalid controller port.');
      if (!stopped) emulator?.setInputState(dolphinPad(pad, connected), seat);
    },
    setMuted(muted) {if (localGain) localGain.gain.value = muted ? 0 : 1;},
    stop,
  };
}
