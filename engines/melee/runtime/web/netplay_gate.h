#pragma once

#include <array>
#include <condition_variable>
#include <cstdint>
#include <mutex>

namespace opensmash {
// One packet describes all four controller ports for one emulated VI field.
// Only the network producer writes packets; only the CPU thread consumes them.
using NetplayPads = std::array<std::array<std::uint32_t, 4>, 4>;

class NetplayGate {
public:
  static constexpr std::uint32_t Capacity = 128;
  enum Result { Accepted = 0, WrongFrame = 1, Full = 2, Stopped = 3 };

  Result Submit(std::uint32_t frame, const NetplayPads& pads) {
    std::lock_guard lock(m_mutex);
    if (m_stopped) return Stopped;
    if (frame != m_submitted) return WrongFrame;
    if (m_submitted - m_consumed == Capacity) return Full;
    m_frames[frame % Capacity] = pads;
    ++m_submitted;
    m_ready.notify_one();
    return Accepted;
  }

  // A missing packet suspends the CPU, including timers and all game logic.
  // Wall-clock time passing never substitutes an old packet or neutral input.
  bool Wait(NetplayPads& pads) {
    std::unique_lock lock(m_mutex);
    m_requested = m_consumed;
    m_waiting = true;
    m_ready.wait(lock, [&] { return m_stopped || m_consumed != m_submitted; });
    if (m_stopped) return false;
    pads = m_frames[m_consumed % Capacity];
    ++m_consumed;
    m_waiting = false;
    return true;
  }

  std::uint32_t Requested() {
    std::lock_guard lock(m_mutex);
    return m_waiting ? m_requested : UINT32_MAX;
  }

  void Stop() {
    std::lock_guard lock(m_mutex);
    m_stopped = true;
    m_ready.notify_all();
  }

private:
  std::mutex m_mutex;
  std::condition_variable m_ready;
  std::array<NetplayPads, Capacity> m_frames{};
  std::uint32_t m_submitted = 0, m_consumed = 0, m_requested = 0;
  bool m_waiting = false, m_stopped = false;
};
} // namespace opensmash
