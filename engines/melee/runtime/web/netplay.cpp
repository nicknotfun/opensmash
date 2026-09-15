#include "netplay_gate.h"
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <emscripten.h>

namespace {
opensmash::NetplayGate gate;
opensmash::NetplayPads input_buffer{};
std::atomic<bool> enabled{false};
std::uint32_t rtc_seed = 0;
}

extern "C" void opensmash_set_pad(unsigned, unsigned, unsigned, unsigned, unsigned);

extern "C" EMSCRIPTEN_KEEPALIVE unsigned opensmash_netplay_version() { return 1; }
extern "C" EMSCRIPTEN_KEEPALIVE unsigned opensmash_netplay_enable(unsigned seed) {
  if (enabled.load()) return 0; // A session always owns a fresh runtime.
  rtc_seed = seed;
  enabled.store(true);
  return 1;
}
extern "C" unsigned opensmash_netplay_enabled() { return enabled.load(); }
extern "C" unsigned opensmash_netplay_epoch() {
  return 946684800u + rtc_seed % 315360000u;
}
extern "C" EMSCRIPTEN_KEEPALIVE unsigned* opensmash_netplay_input_buffer() {
  return input_buffer[0].data();
}
extern "C" EMSCRIPTEN_KEEPALIVE unsigned opensmash_netplay_submit(unsigned frame) {
  if (!enabled.load()) return opensmash::NetplayGate::Stopped;
  for (const auto& pad : input_buffer)
    if ((pad[0] & ~0x1f7fu) || pad[2] > 0xffff || pad[3] > 1)
      return 4;
  return gate.Submit(frame, input_buffer);
}
extern "C" EMSCRIPTEN_KEEPALIVE unsigned opensmash_netplay_requested() {
  return gate.Requested();
}
extern "C" EMSCRIPTEN_KEEPALIVE void opensmash_netplay_stop() { gate.Stop(); }

// Called on the CPU thread before VI advances the field or polls controllers.
// Emscripten's owner worker remains free to receive network packets while the
// condition variable waits on shared Wasm memory.
extern "C" void opensmash_netplay_frame() {
  if (!enabled.load()) return;
  opensmash::NetplayPads pads;
  if (!gate.Wait(pads)) {
    std::fputs("[opensmash] multiplayer session stopped\n", stderr);
    std::abort(); // Never resume simulation after a disconnect or protocol error.
  }
  for (unsigned port = 0; port < pads.size(); ++port)
    opensmash_set_pad(port, pads[port][0], pads[port][1], pads[port][2], pads[port][3]);
}
