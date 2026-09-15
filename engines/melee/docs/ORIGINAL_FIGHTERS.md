# Playing original Melee fighters

In the shared website, select **Melee**, open **Settings → Gameplay Options**,
and choose each player's original fighter under **Original Melee fighters**. **Play original
Melee** creates the usual unique game link. It preserves explicit original
choices and fills the remaining slots with Mario for player 1 and random
original fighters for the other players. Joined players take human slots; empty
slots use CPUs. Each player selects their own unmodified USA 1.02 ISO/GCM.
The disc stays in that player's browser.

Original fighter choices override website roster picks. Choose **Use website
roster selection** to return a player to custom characters. Mixed lineups remain
supported. Only custom fighters that are actually used need source imports,
costume conversion, and custom character-select assets. An all-original lineup
uses the costumes, menus, and audio already present on each player's disc.

## Deployment prerequisites

The browser runtime must still be compiled and deployed once. This project's
current Wasm includes code statically recompiled from the verified ISO's
`main.dol`; it is not a generic runtime that can be completely built without game
code. The operator handles extraction, verification, compilation and deployment.
Players do not need to compile anything or create a conversion workspace.
Runtime build identity and multiplayer capability checks still apply.

The existing hosted asset service requires its private verified workspace before
it serves engine assets. The operator must provision that workspace, the matching
browser build, and its Dolphin system-resource bundle. Selecting an ISO in a
browser does not provision the server. See [CHECKOUT.md](CHECKOUT.md) for the build
sequence and [the hosted service notes](../server/README.md) for storage paths.

Custom OpenSmash fighters additionally require their original `rigged.glb` and
presentation source assets. Published Smash 64 `.osb6` bundles do not contain
those original rigs. A mirrored portrait/bundle catalog is enough to display the
roster, but cannot manufacture missing Melee character sources. Original Melee
fighters avoid that dependency. See [CHARACTER_IMPORT.md](CHARACTER_IMPORT.md).

The original-fighter launch tests verify configuration and the absence of custom
conversion requests. They do not establish gameplay or cross-browser game
synchronization without the compiled runtime and a real ISO.
