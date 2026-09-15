#include "../runtime/web/netplay_gate.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <future>
#include <thread>

using namespace std::chrono_literals;
using opensmash::NetplayGate;
using opensmash::NetplayPads;

int main() {
  NetplayGate gate;
  std::atomic<unsigned> completed{0};
  NetplayPads received;
  auto consumer = std::async(std::launch::async, [&] {
    assert(gate.Wait(received));
    ++completed;
    NetplayPads second;
    assert(!gate.Wait(second));
  });
  const auto deadline = std::chrono::steady_clock::now() + 2s;
  while (gate.Requested() != 0 && std::chrono::steady_clock::now() < deadline)
    std::this_thread::yield();
  assert(gate.Requested() == 0);
  assert(consumer.wait_for(30ms) == std::future_status::timeout);
  assert(completed == 0); // No prediction and no timeout that advances the CPU.

  NetplayPads packet{{{0x100, 0x01020304, 0x0506, 1},
                     {0x200, 0x0708090a, 0x0b0c, 1},
                     {0, 0x80808080, 0, 0}, {0, 0x80808080, 0, 0}}};
  assert(gate.Submit(1, packet) == NetplayGate::WrongFrame);
  assert(gate.Submit(0, packet) == NetplayGate::Accepted);
  assert(gate.Submit(0, packet) == NetplayGate::WrongFrame);
  const auto second_deadline = std::chrono::steady_clock::now() + 2s;
  while (gate.Requested() != 1 && std::chrono::steady_clock::now() < second_deadline)
    std::this_thread::yield();
  assert(gate.Requested() == 1);
  assert(completed == 1 && received == packet); // All four ports arrive together.
  assert(consumer.wait_for(30ms) == std::future_status::timeout);
  gate.Stop();
  assert(consumer.wait_for(2s) == std::future_status::ready);
  consumer.get();
  assert(gate.Submit(1, packet) == NetplayGate::Stopped);

  NetplayGate bounded;
  for (unsigned i=0;i<NetplayGate::Capacity;i++)
    assert(bounded.Submit(i, packet) == NetplayGate::Accepted);
  assert(bounded.Submit(NetplayGate::Capacity, packet) == NetplayGate::Full);
  for (unsigned i=0;i<NetplayGate::Capacity;i++) {
    assert(bounded.Wait(received));
    assert(received == packet);
  }
  // Exercise ring reuse, which previously queued frames must not overwrite.
  assert(bounded.Submit(NetplayGate::Capacity, packet) == NetplayGate::Accepted);
  assert(bounded.Wait(received) && received == packet);
}
