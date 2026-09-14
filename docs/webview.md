# The webview

`packages/webview` is the UI: a three.js scene and a DOM HUD, built into one `dist/webview.js` that VS Code's panel, the desktop window and the harness all load under the same Content Security Policy. It knows nothing about VS Code or Node: it talks to its host through `HostBridge` (`acquireVsCodeApi()` when the page has it, else `window.orbitHost`), and gets everything by message.

## Composition

`main.ts` wires the modules together with callbacks; none of them imports another's instance.

| Module | Owns |
| --- | --- |
| `host.ts` | `HostBridge`: typed `post` and `on(type, handler)`; `keep`/`kept` for the little state a host persists (the chosen view) |
| `frameLoop.ts` | The visibility-aware, parking requestAnimationFrame loop at two paces: 30 fps for the ambient animation, up to 60 fps while the camera or the pointer moves |
| `scene.ts` | `SceneController`: a graph reset into a layout into a `World`; activity into the World; live updates |
| `stage.ts` | The renderer, camera and controls (rotate and pan; the wheel is `SmoothZoom`'s). Steps the pixel ratio down (2, 1.5, 1) if frames keep missing 30 fps |
| `interaction.ts` | Hover and click through GPU picking; the tooltip; the `grabbing` cursor during a drag |
| `zoom.ts` | `SmoothZoom`: the wheel, eased over frames toward the point under the pointer, pulling a sub-directory bubble to the middle of the screen so that zooming into it opens it |
| `focus.ts` | What is on screen, derived from the camera alone: which directory is looked into, and the crossfade between a directory and the sub-directory being zoomed into |
| `dirView.ts` | What the view navigates: skipped directories (one holding nothing but one sub-directory), the root, and where the view starts |
| `world.ts` and `world/` | Every layer for one graph and its frozen layout, and the state that must survive a live update |
| `layout/` | The nested layout worker (inlined into the bundle as a string and started from a Blob URL) and its client |
| `flatLayout.ts`, `neurons.ts`, `orbits.ts` | The Flat view: files on orbits by project, the import arcs, the orbit rings and the core |
| `tour.ts` | Take a Tour |
| `hud/` | The DOM: identity and breadcrumb, the view tabs, the tooltip, the drawer and composer, the Claude bubbles, the conversation view, the constellation (skills, history, MCP), the history panel, the file card, the editor sheet, the spark popup, the tour button and card, the status overlay and the performance readout |
| `constellation/` | The skills, history and MCP panel's own WebGL canvas: a small force layout, instanced glow glyphs, a tesseract per skill, a gyroscope per conversation, a 16-cell per MCP server |
| `picking.ts`, `uniforms.ts`, `nodeState.ts`, `palette.ts` | GPU picking, the uniforms every material shares, the per-file state texture, the colours |

## Layers

`World` owns, for one graph:

- `NodeLayer`: every file, one instanced mesh.
- `Bubbles`: every directory.
- `EdgeLayer`: every import, one draw object, with visibility and highlighting decided in the shader.
- `ParticleLayer`: the comets of reads.
- `ClaudeLayer`: a star per conversation with a turn under way (the first is always there; further ones fade in on a ring around its home), and a smaller star per subagent that comes out of its conversation's star and goes back into it.
- `McpLayer`: a station per MCP server a conversation calls, orbiting that conversation's star on a beam.

Everything keyed by node index (state texels, instance attributes, pick ids, label keys) is rebuilt for each World. State that must survive a live update is copied in `World.adopt()` through the index remap: the shared uniforms, per-file state, touched files, pending events, comets in flight, Claude's stars and their positions, MCP stations, the directory the camera is inside of, and which star is followed. Anything new that holds animation state needs an adopt too.

## Focus and levels

The camera decides what is drawn. A directory is looked into while the middle of the screen is inside its bubble; zooming from framing the open directory toward framing a sub-directory crossfades from the one's contents to the other's on a log scale, and at the end the sub-directory opens. Zooming back out retraces the same curve, and so does panning until the middle of the screen leaves the bubble, so no way in or out jumps. A click, Esc or the breadcrumb eases the camera over 600 ms and opens only the directories on the way.

In the shaders, a file shows while its own directory's contents are on screen (and wherever Claude is working on it), a bubble while its view parent's are, and the shown directory's own bubble is a faint frame. One level up, a directory's files, lines and sub-bubbles show through its bubble at reduced strength; two levels up, fainter still; so the import network stays visible and fires while Claude thinks, and the nesting reads while zoomed out. The directories beside the shown one keep a faint rim each. Each import is drawn in exactly one directory, the deepest holding both files, as a segment between the two things shown there that contain them.

## GPU picking

There is no raycasting. Each pickable mesh has a visible material and a pick material built from the same shader source, and a click or hover reads the id under the pointer from a render target, asynchronously. Ids are 24-bit: 0 is nothing, node `i` is `i + 1`, cluster `c` is a base plus `c`, and a Claude star is another base plus its stable id. Only what the directory dominating the screen shows is pickable: its own files and its sub-directory bubbles; Claude's stars are pickable regardless. Hover picks run one per frame while the pointer moves, none during a drag.

## GPU animation

Every material shares the uniforms from `uniforms.ts` by reference. Per-file activity lives in one float data texture: when it was read, when edited, its weight, when it was added. Shaders derive glow, pulses and fades from the current time and the time of rest, so the CPU writes a few texels per event and nothing per frame. A read's texel is written when its comet lands, not at launch, or each read would put out the glow already there; landings still in flight when the turn ends are dropped. A thought writes only a burst window, and the edge shader fires every segment it doesn't clip with a rhythm seeded by the source end's position, so all lines out of one file fire together and keep their rhythm across a live update.

## The frame loop

`frame()` renders one frame and returns whether another is needed and at which pace: smooth while the camera moves or a hover pick is wanted, ambient for everything else, parked when nothing moves. While a turn runs the edges keep flowing, so the loop runs for the whole turn; while the page is hidden it renders nothing at all. Anything that starts moving without going through an input or a host message has to wake the loop, or the scene freezes.

## Colours

`palette.ts` holds sRGB triples that the shaders write straight to the framebuffer, never routed through `THREE.Color`, which converts to linear. Colour is file type: each file's kind, and each directory's dominant kind, come from the node names, and the legend in the HUD is built from the same table. The kind colours sit at mid lightness, clear of the bright read, edit and violet activity colours, and were checked in OKLab for the kinds that meet in one repository.

## Views and the tour

`World.setMode` animates a shared mix from Nested (0) to Flat (1). The file mesh morphs rather than a second mesh appearing: the vertex shader flies each file on an arc once its delay has passed and prints its icon from an atlas drawn once on a canvas; bubbles and the Nested lines fade out as the mix rises, and the neurons and orbits fade in. In Flat, focus is frozen from above the orbits' plane, the breadcrumb is the root alone, and the wheel closes in on the file under the pointer.

The tour picks each stop at random (hubs and large files weighted up, nowhere twice until every candidate has been) and flies there through `Focus`: out to the directory holding both places on the bearing the camera already has, then in to the stop on a new one. Some stops get a card with facts worked out from the graph alone. While it runs, hover, clicks, Esc, the breadcrumb, the wheel and the tabs are off; a live update re-finds the stop by id, and a reset ends the tour. `__orbit.startTour({ seed, cards })` makes a run repeatable for the harness.

## The HUD

- **Composer.** The drawer and the conversation view each hold one: skill and file chips, the input, and a bar of Files, Skills, the model, the effort meter, the permission mode and Send (Stop, in the view, while the conversation works). The drawer adds History and the MCP button. A slash typed alone opens the Skills constellation filtered to the text after it; Enter attaches the pick in place of the command.
- **Constellation.** Draws on its own transparent canvas over the whole viewport, only while open. Its glyphs take input through transparent buttons kept over them (a skill is dragged with pointer capture and dropped on the composer that opened the panel); nothing in it is a raycaster either. Under History, a two-thumb time range narrows the conversations shown.
- **Markdown** replies are rendered as DOM nodes with text nodes, never HTML.
- **File card and editor sheet.** The card is placed beside its file on every rendered frame; Rename and Delete morph the card into a prompt in place. The sheet is CodeMirror 6 with the page's nonce for its styles; Changes is a unified merge view against the base the host sent. A Mod shortcut the editor handled stops propagating, so VS Code's webview host doesn't undo or save a second time.
- **Esc order.** One capturing listener on the window cancels a skill drag, else closes the constellation, the conversation view, the history panel or the drawer; the file card's listener runs before it, and the editor sheet's (on the document) after, before `Interaction` sees the key.

## Hard constraints

The constraint check in `packages/webview/build.mjs` runs before every build and fails it if any source under `packages/webview/src/`:

- mentions `Raycaster` (picking is GPU only);
- calls the synchronous `readRenderTargetPixels(`;
- contains `http://` or `https://`, comments included (the check is a plain regex);
- uses `fetch(`, `XMLHttpRequest` or `importScripts(` (data arrives only by message).

It also requires exactly one instanced mesh in `nodes.ts` and exactly one line, mesh or points object in `edges.ts`: all files are one draw call, and so are all lines.

Also required, though no build checks them: three.js is bundled locally; styles are injected with the script's nonce (set styles from code through `element.style`, never a `style` attribute string, which the CSP blocks); the page never touches files; and the constellation is no exception to GPU picking of the graph.

## Debugging

**Developer: Open Webview Developer Tools** in VS Code, View › Toggle Developer Tools in the desktop app, or the harness's Chrome. `window.__orbit` exposes `debug` (frames, fps, CPU time per frame, draw calls, live updates applied), `world()`, `project(x, y, z)` (world to screen), `camera()`, `view()`, `constellation()`, `editor()`, `fileMenu()`, `tour()`, `startTour()` and `endTour()`. The performance readout at the bottom right shows the frame rate, CPU time, draw calls and pixel ratio.

The harness (`yarn harness`) runs this bundle in headless Chrome against a simulated host and writes a report and screenshots; [Contributing](contributing.md) says how to read it.
