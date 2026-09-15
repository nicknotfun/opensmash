# Melee insert-disc hardware

`disc-hardware.js` owns the Melee-specific meshes. The shared website launcher
keeps its existing lights, CRT treatment, draggable media, upload music and dock
timing. Melee substitutes a mini-disc and an indigo top-loading console. The
label reuses the existing cartridge artwork; the console badges read `fun`.

The disc is a ring with a real centre hole. The console includes controller
ports, memory-card slots, side vents, a rear handle and a hinged lid. The disc
rotates flat onto the spindle, then the lid closes before the scene exits.
These procedural meshes require no generated-model API or additional assets.

Melee uses its local ISO/GCM validator, and desktop uses its native disc picker.
After docking it launches the selected Melee match; the N64 controller tutorial
is not shown for a GameCube game. Existing verified discs skip setup.

For visual inspection, run the website dev server and open
`/tools/disc-preview.html`. Its insertion slider checks tray clearance and lid
closure using the same models. It does not select a disc or start a game.

Validation: production frontend build and 282 existing website tests pass.
Chrome visual checks cover the real upload screen and the fixture's open/closed
console. A real local ISO reached the validator, but its first attempt found
the local Melee asset proxy unconfigured. The preview server now uses
`MELEE_LOCAL_ORIGIN=http://127.0.0.1:8790`; the full successful upload-to-game
transition still needs a final interactive check. All tests were muted.
