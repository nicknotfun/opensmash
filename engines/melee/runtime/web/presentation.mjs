/** Browser presentation owns snapshots only; it never advances emulated time. */
export function createBitmapPresenter({requestFrame = requestAnimationFrame,
    cancelFrame = cancelAnimationFrame, present, visible = true}) {
  let pending = null, scheduled = null, disposed = false;
  const discard = () => { pending?.close(); pending = null; };
  const schedule = () => {
    if (!disposed && visible && pending && scheduled === null) scheduled = requestFrame(draw);
  };
  function draw() {
    scheduled = null;
    if (disposed || !visible) { discard(); return; }
    const bitmap = pending; pending = null;
    if (bitmap) {
      // transferFromImageBitmap takes ownership; close also handles a missing
      // canvas or a failed presentation without retaining its graphics memory.
      try { present(bitmap); } finally { bitmap.close(); }
    }
    schedule();
  }
  return {
    offer(bitmap) {
      if (disposed || !visible) { bitmap.close(); return; }
      discard(); pending = bitmap; schedule();
    },
    setVisible(value) {
      visible = Boolean(value);
      if (!visible) {
        if (scheduled !== null) cancelFrame(scheduled);
        scheduled = null; discard();
      } else schedule();
    },
    dispose() {
      disposed = true;
      if (scheduled !== null) cancelFrame(scheduled);
      scheduled = null; discard();
    },
  };
}

/** Bound a worker message channel to one unreceived bitmap plus the latest
 * replacement. Receipt is acknowledged before drawing; RAF cannot pace input
 * or simulation. A frozen consumer makes us discard snapshots, never wait. */
export function createBitmapSender({send, visible = true}) {
  let pending = null, inFlight = null, nextId = 1, disposed = false;
  const discard = () => { pending?.close(); pending = null; };
  const flush = () => {
    if (disposed || !visible || inFlight !== null || !pending) return;
    const bitmap = pending, id = nextId++; pending = null; inFlight = id;
    try { send({id, bitmap}); }
    catch (error) { inFlight = null; bitmap.close(); throw error; }
  };
  return {
    offer(bitmap) {
      if (disposed || !visible) { bitmap.close(); return; }
      discard(); pending = bitmap; flush();
    },
    received(id) {
      if (disposed || id !== inFlight) return false;
      inFlight = null; flush(); return true;
    },
    setVisible(value) {
      visible = Boolean(value);
      if (!visible) discard(); else flush();
    },
    dispose() { disposed = true; discard(); },
  };
}
