/* Browser confirmed-input lockstep. The launcher owns the transport; this
 * bridge owns the simulation boundary. Stalls never advance the VI clock. */
#include <stdint.h>
#include <stdlib.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

extern "C" void syUtilsSetRandomSeed(int32_t seed);
static int sEnabled = 0;

extern "C" EMSCRIPTEN_KEEPALIVE int port_netplay_version(void) { return 2; }
extern "C" int port_netplay_enabled(void) { return sEnabled; }

extern "C" void port_netplay_init(void)
{
#ifdef __EMSCRIPTEN__
    const char *enabled = getenv("SSB64_LOCKSTEP");
    sEnabled = enabled && enabled[0] == '1';
    if (sEnabled) {
        const char *seed = getenv("SSB64_LOCKSTEP_SEED");
        syUtilsSetRandomSeed((int32_t)(uint32_t)strtoul(seed ? seed : "1", NULL, 10));
    }
#endif
}

#ifdef __EMSCRIPTEN__
/* Await on the main context, before any coroutine resumes. The browser's
 * display callbacks never schedule the simulation or unblock input. */
extern "C" {
EM_ASYNC_JS(int, port_netplay_wait_frame, (uint32_t tick), {
    try {
        return Module.netplay && await Module.netplay.waitFrame(tick) ? 1 : 0;
    } catch (error) {
        if (Module.netplay) Module.netplay.fail(error);
        return 0;
    }
});
}
#endif

extern "C" int port_netplay_before_frame(uint32_t tick)
{
#ifdef __EMSCRIPTEN__
    if (sEnabled) {
        // Missing JS bridge must hold the game, never fall back to local play.
        return EM_ASM_INT({
            return Module.netplay && Module.netplay.beforeFrame($0) === true ? 1 : 0;
        }, tick);
    }
#endif
    (void)tick;
    return 1;
}
