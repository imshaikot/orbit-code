#!/usr/bin/env node
// Headless check of the webview outside VS Code, under the same CSP.
// Loads @orbit-code/webview's dist/webview.js with a simulated host (src/hostSim.ts), drives it through Chrome
// DevTools Protocol with real mouse and keyboard events (so GPU picking and the composer are
// exercised), measures the frame loop and writes screenshots plus a JSON report.
//
//   yarn harness                               index this repository with the real indexer
//   yarn harness --graph path/to/graph.json    from `yarn index <dir> --out ...`
//   options: --out <dir> (default .harness/out)  --size 1440x900  --scale 1|2  --chrome <path>
//            --skip-build: run the webview, indexer and host-sim builds already there (`yarn harness` has Nx build them)
// Relative paths are taken from the current directory; `yarn harness` runs in the workspace root.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const packages = join(root, 'packages');
const argv = process.argv.slice(2);
const skipBuild = argv.includes('--skip-build');
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

const out = option('out', join(root, '.harness', 'out'));
const [width, height] = option('size', '1440x900').split('x').map(Number);
const scale = Number(option('scale', '1'));
const chromePath = option('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(out, { recursive: true });
const graphPath = option('graph') ?? indexThisRepository();
build();
const nonce = randomBytes(12).toString('base64');
writeFileSync(join(root, '.harness', 'index.html'), page());
const server = await serve();
const chrome = await launchChrome();
const report = { graph: graphPath, viewport: `${width}x${height}@${scale}x`, checks: {}, console: [] };

try {
  const cdp = await connect(chrome.port);
  cdp.on((event) => {
    if (event.method === 'Runtime.consoleAPICalled') report.console.push(`${event.params.type}: ${event.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (event.method === 'Runtime.exceptionThrown') report.console.push(`exception: ${event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text}`);
    if (event.method === 'Log.entryAdded') report.console.push(`${event.params.entry.source}/${event.params.entry.level}: ${event.params.entry.text}`);
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const screenshot = async (name) => writeFileSync(join(out, name), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  // A screenshot decoded by the page itself and kept as `__shots[key]`, for pixel comparisons.
  const capture = async (key, name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (name) writeFileSync(join(out, name), Buffer.from(data, 'base64'));
    await evaluate(`new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height });
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        (window.__shots ??= {})[${JSON.stringify(key)}] = context.getImageData(0, 0, image.width, image.height).data;
        resolve();
      };
      image.onerror = () => resolve();
      image.src = 'data:image/png;base64,${data}';
    })`);
    return data;
  };
  // Pixels that grew much redder and bluer (violet to white) between two captures. Flowing dashes stay dim blue.
  const violetGain = (from, to) => evaluate(`(() => {
    const a = __shots[${JSON.stringify(from)}], b = __shots[${JSON.stringify(to)}];
    let lit = 0;
    for (let i = 0; i < a.length; i += 4) if (b[i] - a[i] > 45 && b[i + 2] - a[i + 2] > 45) lit++;
    return lit;
  })()`);
  const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  const click = async (x, y) => {
    await mouse('mousePressed', x, y);
    await mouse('mouseReleased', x, y);
  };
  const key = async (keyName, code, keyCode) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyCode });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode });
  };
  const tooltipTitle = () => evaluate(`document.querySelector('.tooltip').hidden ? null : document.querySelector('.tooltip-title').textContent`);
  const location = () => evaluate(`(() => {
    const w = __orbit.world(); const crumb = document.querySelector('.crumb-current');
    return { focus: w.focus.cluster, label: w.layout.clusters.labels[w.focus.cluster], breadcrumb: crumb?.textContent ?? null, breadcrumbPath: crumb?.dataset.path ?? null };
  })()`);
  // The front-most of the larger bubbles shown in the directory being looked into, projected clear of the HUD.
  const bubbleTarget = () => evaluate(`(() => {
    const w = __orbit.world(); const c = w.layout.clusters; const focus = w.focus.cluster;
    const shown = [];
    for (let i = 0; i < c.radii.length; i++) if (w.view.shown[i] && w.view.viewParent[i] === focus) shown.push(i);
    if (shown.length === 0) return null;
    const median = shown.map((i) => c.radii[i]).sort((a, b) => a - b)[Math.floor(shown.length / 2)];
    let best = null;
    for (const i of shown) {
      if (c.radii[i] < median) continue;
      const p = __orbit.project(c.centers[i * 3], c.centers[i * 3 + 1], c.centers[i * 3 + 2]);
      if (p.x < 60 || p.y < 160 || p.x > innerWidth - 60 || p.y > innerHeight - 160) continue;
      if (!best || p.depth < best.depth) best = { cluster: i, name: w.clusterName(i), x: p.x, y: p.y, depth: p.depth };
    }
    return best;
  })()`);
  // Hover a bubble, click it, and report where the view ended up. Bubbles and files can overlap on screen, so the
  // id pass may rightly answer with a nearer one: hover and breadcrumb must then agree.
  const drillInto = async (target, name) => {
    await mouse('mouseMoved', target.x, target.y);
    await sleep(500);
    const tooltip = await tooltipTitle();
    await click(target.x, target.y);
    await sleep(1400);
    const now = await location();
    if (name) await screenshot(name);
    return { aimedAt: target.name, tooltip, focused: now.label, breadcrumb: now.breadcrumb, breadcrumbPath: now.breadcrumbPath, matchesHover: now.breadcrumbPath === tooltip, reachedTarget: now.focus === target.cluster };
  };

  const loadStarted = Date.now();
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/.harness/index.html` });
  if (!(await waitFor(evaluate, '!!window.__orbit?.world()', 60_000))) throw new Error('scene never became ready');
  report.checks.sceneReadyMs = Date.now() - loadStarted;
  report.checks.gpu = await evaluate(`(() => { const gl = document.querySelector('canvas').getContext('webgl2'); const info = gl.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`);
  report.checks.scene = await evaluate(`(() => { const w = __orbit.world(); return { files: w.graph.nodes.count, imports: w.graph.edges.length / 2, bubbles: w.clusterCount, bubblesAtRoot: w.view.children[w.view.root].length }; })()`);
  // Colour is file type: the legend names the kinds in the graph, files wear their kind's colour, bubbles their dominant kind's.
  report.checks.fileKinds = await evaluate(`(() => {
    const w = __orbit.world();
    return {
      legend: [...document.querySelectorAll('.legend-item')].map((item) => item.textContent),
      kindsInFiles: new Set(w.kinds).size,
      kindsInBubbles: new Set(w.dominantKinds).size,
    };
  })()`);
  // The view opens in the source directory (src, lib, …) when the root has one, else at the root.
  report.checks.startsIn = await evaluate(`(() => {
    const w = __orbit.world(); const labels = w.layout.clusters.labels;
    return { focus: labels[w.focus.cluster], start: labels[w.view.start], root: labels[w.view.root], breadcrumb: document.querySelector('.crumb-current')?.textContent ?? null, atStart: w.focus.cluster === w.view.start };
  })()`);

  // The simulated host starts a scripted turn on sceneReady: measure the frame loop while it animates.
  await sleep(2200);
  await screenshot('1-overview-activity.png');
  // That turn did not come from the drawer (as with Orbit Code: Ask Claude…), so its Claude bubble rose from the drawer tab.
  const firstBubble = await evaluate(`(() => {
    const b = document.querySelector('.claude-bubble');
    return b ? { phase: b.dataset.phase, title: b.querySelector('.claude-bubble-title').textContent } : null;
  })()`);
  const f0 = await evaluate('__orbit.debug.frames');
  const samples = [];
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    samples.push(await evaluate('({ ...__orbit.debug })'));
  }
  const f1 = await evaluate('__orbit.debug.frames');
  report.checks.frameLoop = {
    measuredFps: +((f1 - f0) / 3.3).toFixed(1),
    reportedFps: +samples.at(-1).fps.toFixed(1),
    cpuMsPerFrame: +(samples.reduce((sum, s) => sum + s.cpuMs, 0) / samples.length).toFixed(2),
    drawCalls: samples.at(-1).calls,
    triangles: samples.at(-1).triangles,
  };
  // Camera motion, while the turn still animates at the ambient pace: a drag orbits at the smooth pace, with no hover
  // pick and no tooltip while the button is down; a wheel burst zooms eased over frames at the smooth pace too, and
  // brings the view back where it was when reversed. Frames are counted against the wall clock over each gesture.
  {
    const cx = Math.round(width / 2);
    const cy = Math.round(height / 2);
    const framesOver = async (act) => {
      const f0 = await evaluate('__orbit.debug.frames');
      const t0 = Date.now();
      const cpu = [];
      await act(cpu);
      const ms = Date.now() - t0;
      const frames = (await evaluate('__orbit.debug.frames')) - f0;
      return { frames, ms, fps: +((frames * 1000) / ms).toFixed(1), cpuMs: cpu.length > 0 ? +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(2) : null };
    };
    const cameraState = () => evaluate(`__orbit.camera()`);
    const apart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const dragFrom = { x: cx - 150, y: cy + 40 };
    const steps = 20;
    const dragTo = { x: dragFrom.x + steps * 12, y: dragFrom.y };
    const dragAcross = async (from, to, cpu) => {
      await mouse('mousePressed', from.x, from.y);
      for (let k = 1; k <= steps; k++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * k) / steps, y: from.y + ((to.y - from.y) * k) / steps, button: 'left', buttons: 1 });
        await sleep(16);
        if (k % 5 === 0) cpu.push(await evaluate('__orbit.debug.cpuMs'));
      }
      await mouse('mouseReleased', to.x, to.y);
    };
    await mouse('mouseMoved', dragFrom.x, dragFrom.y);
    await sleep(400);
    const before = await cameraState();
    let tooltipDuringDrag = false;
    let cursorDuringDrag = null;
    const drag = await framesOver(async (cpu) => {
      await dragAcross(dragFrom, dragTo, cpu);
    });
    // Sampled at the end of the drag, before the button came up: the hover pick is skipped and the tooltip stays hidden.
    await mouse('mousePressed', dragTo.x, dragTo.y);
    for (let k = 1; k <= 6; k++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragTo.x - k * 12, y: dragTo.y, button: 'left', buttons: 1 });
      await sleep(16);
    }
    await sleep(250);
    tooltipDuringDrag = (await tooltipTitle()) !== null;
    cursorDuringDrag = await evaluate(`document.querySelector('canvas.stage').style.cursor`);
    await mouse('mouseReleased', dragTo.x - 72, dragTo.y);
    const after = await cameraState();
    // Back the same way, so the view is where it was for the checks that follow.
    await dragAcross({ x: dragTo.x - 72, y: dragTo.y }, { x: dragFrom.x, y: dragFrom.y }, []);
    await sleep(600);
    // The wheel: six notches in, then six out. Zoom is eased, so the frames come at the smooth pace until it settles.
    await mouse('mouseMoved', cx, cy);
    await sleep(200);
    const wheelAt = (deltaY) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY });
    const zoomIn = await framesOver(async (cpu) => {
      for (let k = 0; k < 6; k++) {
        await wheelAt(-100);
        await sleep(30);
        cpu.push(await evaluate('__orbit.debug.cpuMs'));
      }
      await sleep(350);
    });
    const zoomedIn = await cameraState();
    for (let k = 0; k < 6; k++) {
      await wheelAt(100);
      await sleep(30);
    }
    await sleep(600);
    const zoomedBack = await cameraState();
    // A drag orbits the target: the camera moves, the target stays. The wheel changes the distance to the target, and the
    // same notches back restore it (the pull toward a bubble under the pointer only moves sideways).
    report.checks.motion = {
      drag: { ...drag, cameraMoved: apart(after.position, before.position) > 0.02 * before.distance, targetKept: apart(after.target, before.target) < 0.02 * before.distance, tooltipDuringDrag, cursorDuringDrag },
      zoom: { ...zoomIn, zoomedIn: zoomedIn.distance < 0.8 * before.distance, distanceRestored: Math.abs(zoomedBack.distance - before.distance) < 0.05 * before.distance },
    };
  }
  await waitFor(evaluate, `__host.state().phase === 'idle'`, 10_000);
  report.checks.transcript = await evaluate(`({
    entries: document.querySelectorAll('.transcript .t-entry').length,
    fileLinks: document.querySelectorAll('.transcript [data-file]').length,
    lastEntry: document.querySelector('.transcript .t-entry:last-child')?.textContent,
    markdownBlocks: document.querySelectorAll('.transcript .md-heading, .transcript .md-list, .transcript .md-table, .transcript .md-code, .transcript .md-quote').length,
  })`);
  report.checks.firstBubble = { whileWorking: firstBubble, leftAfterTurn: await waitFor(evaluate, `!document.querySelector('.claude-bubble')`, 6_000) };

  // Claude's star, at rest: a click brings up "Follow Spark"; choosing it eases the camera to frame the star (the
  // popup is for whichever star was clicked, the first one's stable id always 0) and keeps the target on it — after
  // the tween, the star projects to the middle of the screen. Clicking the star again offers to stop following.
  // A drag while following still orbits the camera: user control keeps working, and Follow stays on regardless.
  const starProjection = () => evaluate(`(() => {
    const w = __orbit.world();
    const p = w.claudePosition(w.following ?? 0);
    return p ? __orbit.project(p.x, p.y, p.z) : null;
  })()`);
  const toggleCentre = () => evaluate(`(() => {
    const e = document.querySelector('.spark-popup-toggle');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const spark = {};
  const starAt = await starProjection();
  spark.starOnScreen = !!starAt && starAt.depth > -1 && starAt.depth < 1 && starAt.x >= 0 && starAt.y >= 0 && starAt.x <= width && starAt.y <= height;
  if (spark.starOnScreen) {
    await click(starAt.x, starAt.y);
    await sleep(250);
    spark.popupOpenedOnClick = await evaluate(`!document.querySelector('.spark-popup').hidden`);
    spark.toggleLabel = await evaluate(`document.querySelector('.spark-popup-toggle')?.textContent`);
    const toggle = await toggleCentre();
    if (toggle) await click(toggle.x, toggle.y);
    await sleep(800); // the follow tween (600ms) plus a margin
    spark.popupClosedAfterChoosing = await evaluate(`document.querySelector('.spark-popup').hidden`);
    spark.followingAfterToggle = await evaluate(`__orbit.world().following ?? null`);
    const centered = await starProjection();
    spark.centeredWhileFollowing = !!centered && Math.abs(centered.x - width / 2) < 60 && Math.abs(centered.y - height / 2) < 60;
    await mouse('mousePressed', width / 2, height / 2);
    for (let k = 1; k <= 8; k++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width / 2 + k * 15, y: height / 2, button: 'left', buttons: 1 });
      await sleep(20);
    }
    await mouse('mouseReleased', width / 2 + 120, height / 2);
    await sleep(300);
    spark.followingSurvivedDrag = (await evaluate(`__orbit.world().following ?? null`)) === spark.followingAfterToggle;
    const starAt2 = await starProjection();
    if (starAt2) {
      await click(starAt2.x, starAt2.y);
      await sleep(250);
      spark.toggleLabelWhileFollowing = await evaluate(`document.querySelector('.spark-popup-toggle')?.textContent`);
      const toggle2 = await toggleCentre();
      if (toggle2) await click(toggle2.x, toggle2.y);
      await sleep(300);
      spark.followingAfterSecondToggle = await evaluate(`__orbit.world().following ?? null`);
    }
  }
  report.checks.spark = spark;

  // A subagent: its smaller star comes out of Claude's and waits beside it. Followed, so that it is on screen whatever
  // the framing, a click on it opens what the subagent was asked and has done, which the session view leaves out; a
  // read takes the star over the file; once done, it goes back into Claude's star and leaves, its output still up until Esc.
  const agentStar = () => evaluate(`(() => {
    const w = __orbit.world();
    const id = w.claudeAgentStars[0];
    const p = id === undefined ? undefined : w.claudePosition(id);
    return p ? { world: [p.x, p.y, p.z], ...__orbit.project(p.x, p.y, p.z) } : null;
  })()`);
  const subagent = { starsBefore: await evaluate('__orbit.world().claudeStars') };
  const agentId = await evaluate('__host.subagent()');
  subagent.starCameOut = await waitFor(evaluate, '__orbit.world().claudeAgentStars.length === 1', 3_000);
  await sleep(600); // it fades in beside Claude's star
  await evaluate('(() => { const w = __orbit.world(); w.follow(w.claudeAgentStars[0]); })()');
  await sleep(1_500); // the camera pans until the star sits in the middle
  const agentAt = await agentStar();
  subagent.onScreen = !!agentAt && agentAt.depth > -1 && agentAt.depth < 1 && agentAt.x >= 0 && agentAt.y >= 0 && agentAt.x <= width && agentAt.y <= height;
  if (subagent.onScreen) {
    await click(agentAt.x, agentAt.y);
    await sleep(300);
    Object.assign(
      subagent,
      await evaluate(`(() => {
        const popup = document.querySelector('.spark-popup');
        return {
          popupOpened: !popup.hidden && popup.dataset.kind === 'agent',
          title: document.querySelector('.spark-popup-title')?.textContent,
          status: popup.dataset.status,
          lines: document.querySelectorAll('.spark-popup-log .spl-line').length,
          leftOutOfSessionView: ![...document.querySelectorAll('.transcript .t-entry')].some((entry) => entry.textContent.includes('Subagent report:')),
        };
      })()`),
    );
    await screenshot('1e-subagent.png');
    await evaluate(`__host.subagentRead(${JSON.stringify(agentId)})`);
    await sleep(1_000);
    const moved = await agentStar();
    subagent.movedToFile = !!moved && Math.hypot(moved.world[0] - agentAt.world[0], moved.world[1] - agentAt.world[1], moved.world[2] - agentAt.world[2]) > 1;
    subagent.readLogged = (await evaluate(`document.querySelectorAll('.spark-popup-log .spl-line').length`)) === subagent.lines + 1;
  }
  await evaluate(`__host.subagentEnd(${JSON.stringify(agentId)})`);
  subagent.shownDone = await waitFor(evaluate, `document.querySelector('.spark-popup').dataset.status === 'done'`, 3_000);
  subagent.starLeft = await waitFor(evaluate, `__orbit.world().claudeAgentStars.length === 0 && __orbit.world().claudeStars === ${subagent.starsBefore}`, 8_000);
  subagent.followDropped = (await evaluate('__orbit.world().following ?? null')) === null;
  if (subagent.popupOpened) {
    subagent.outputKept = await evaluate(`!document.querySelector('.spark-popup').hidden`);
    await key('Escape', 'Escape', 27);
    subagent.closedByEscape = await evaluate(`document.querySelector('.spark-popup').hidden`);
  }
  await waitFor(evaluate, `!document.querySelector('.claude-bubble')`, 6_000);
  report.checks.subagent = subagent;

  // A thought while idle: every import line on screen fires, then the loop parks again. Seen from inside the directory
  // with the most imports between its own files (the root may show no lines at all), with the HUD hidden and the loop
  // parked before and after, so the firing lines are what lights up.
  const busiest = await evaluate(`(() => {
    const w = __orbit.world(); const edges = w.graph.edges; const of = w.layout.clusterOf; const counts = new Map();
    for (let e = 0; e < edges.length; e += 2) {
      const c = of[edges[e]];
      if (c === of[edges[e + 1]] && w.view.shown[c]) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const [cluster, segments] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [w.view.root, 0];
    w.goTo(cluster);
    return { cluster, label: w.layout.clusters.labels[cluster], segments };
  })()`);
  await evaluate(`document.querySelector('.hud').style.visibility = 'hidden'`);
  await mouse('mouseMoved', 2, 2); // wakes the parked loop, so the camera moves in
  await sleep(300);
  const parkedBefore = await waitFor(evaluate, `!__orbit.debug.rendering && !__orbit.world().focus.animating && __orbit.world().focus.cluster === ${busiest.cluster}`, 10_000);
  await capture('rest');
  await evaluate('__host.think()');
  const lit = [];
  let burst;
  let brightest;
  for (let k = 0; k < 4; k++) {
    await sleep(450);
    const shot = await capture('firing');
    burst ??= await evaluate(`(() => { const u = __orbit.world().uniforms; return { time: u.uTime.value, start: u.uThinkStart.value, end: u.uThinkEnd.value, rendering: __orbit.debug.rendering }; })()`);
    lit.push(await violetGain('rest', 'firing'));
    if (lit[k] === Math.max(...lit)) brightest = shot;
  }
  writeFileSync(join(out, '1b-thinking.png'), Buffer.from(brightest, 'base64'));
  const parkedAfter = await waitFor(evaluate, '!__orbit.debug.rendering', 10_000);
  await capture('after');
  report.checks.thinking = {
    lookingInto: busiest.label,
    segmentsInView: busiest.segments,
    parkedBefore,
    firingNow: burst.start <= burst.time && burst.time <= burst.end,
    renderingWhileFiring: burst.rendering,
    litPixels: Math.max(...lit),
    litPixelsPerCapture: lit,
    litPixelsAfterFade: await violetGain('rest', 'after'),
    parkedAfter,
  };
  // Back to the root, where the drill-in checks start.
  await evaluate('__orbit.world().goTo(__orbit.world().view.root)');
  await mouse('mouseMoved', 4, 4);
  await sleep(300);
  await waitFor(evaluate, '!__orbit.debug.rendering && !__orbit.world().focus.animating', 10_000);
  await evaluate(`document.querySelector('.hud').style.visibility = ''`);

  // File menu: a click on a file brings its card out beside it, with View diff only when git has changes. Open slides
  // the editor sheet up on the file; typing and Mod-S save through the host, Changes shows the diff against HEAD, an
  // edit made elsewhere replaces the unchanged text, and Esc closes the sheet, then the card, without moving the camera.
  // Rename keeps the file where it was. Delete asks with a button that arms first, collapses the file, and the update
  // that follows removes it.
  const chord = async (keyName, code, keyCode, modifiers) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const clickOn = async (selector) => {
    const at = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (at) await click(at.x, at.y);
    return at !== null;
  };
  const mod = (await evaluate('/Mac|iPhone|iPad/.test(navigator.platform)')) ? 4 : 2;
  // Into a directory with many files of its own, where three can be clicked apart from each other; back afterwards. The
  // camera frames a bubble, but what opens follows from the orbit target, and a neighbouring bubble can claim it: so
  // the candidates are tried, most files first, until the view really is inside one.
  const fileHome = await evaluate(`(() => {
    const w = __orbit.world(); const counts = new Map(); const labels = w.layout.clusters.labels;
    for (let i = 0; i < w.graph.nodes.count; i++) counts.set(w.layout.clusterOf[i], (counts.get(w.layout.clusterOf[i]) ?? 0) + 1);
    const candidates = [...counts].filter(([c, n]) => w.view.shown[c] && n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => labels[c]);
    return { candidates, back: labels[w.focus.cluster], label: candidates[0] ?? labels[w.focus.cluster], tried: [] };
  })()`);
  for (const label of fileHome.candidates) {
    const cluster = await evaluate(`(() => { const w = __orbit.world(); const c = w.layout.clusters.labels.indexOf(${JSON.stringify(label)}); w.goTo(c); return c; })()`);
    await mouse('mouseMoved', 4 + fileHome.tried.length, 4);
    await sleep(300);
    const arrived = await waitFor(evaluate, `!__orbit.world().focus.animating && __orbit.world().focus.cluster === ${cluster}`, 4_000);
    fileHome.tried.push({ label, arrived, landedIn: await evaluate('__orbit.world().layout.clusters.labels[__orbit.world().focus.cluster]') });
    if (arrived) {
      fileHome.label = label;
      break;
    }
  }
  await sleep(500);
  const fileSpots = await evaluate(`(() => {
    const w = __orbit.world(); const n = w.graph.nodes; const focus = w.focus.cluster; const pos = w.layout.positions;
    const id = (i) => n.dirs[n.dirIndex[i]] === '.' ? n.names[i] : n.dirs[n.dirIndex[i]] + '/' + n.names[i];
    const spots = [];
    for (let i = 0; i < n.count && spots.length < 3; i++) {
      if (w.layout.clusterOf[i] !== focus) continue;
      const p = __orbit.project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      // Clear of the HUD at the top and the bottom edge, and apart from each other so a click finds the file aimed at.
      if (p.x < 80 || p.y < 170 || p.x > innerWidth - 80 || p.y > innerHeight - 110) continue;
      if (spots.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 40)) continue;
      spots.push({ id: id(i), x: p.x, y: p.y });
    }
    return spots;
  })()`);
  const openCard = async (spot) => {
    await mouse('mouseMoved', spot.x, spot.y);
    await sleep(400);
    const hovered = await tooltipTitle();
    await click(spot.x, spot.y);
    await sleep(500);
    return {
      hovered,
      ...(await evaluate(`(() => {
        const s = __orbit.fileMenu();
        const items = [...document.querySelectorAll('.file-menu .fm-item')].filter((item) => !item.hidden).map((item) => item.querySelector('.fm-label').textContent);
        return { open: s.open, path: s.path ?? null, items, selected: __orbit.world().selected, focus: __orbit.world().focus.cluster };
      })()`)),
    };
  };
  if (fileSpots.length === 3) {
    const [first, second, third] = fileSpots;
    await evaluate(`__host.git(${JSON.stringify(first.id)}, 'clean')`);
    const clean = await openCard(first);
    await key('Escape', 'Escape', 27);
    await sleep(400);
    const afterCardEscape = await evaluate(`({ open: __orbit.fileMenu().open, focus: __orbit.world().focus.cluster, selected: __orbit.world().selected })`);
    await evaluate(`__host.git(${JSON.stringify(first.id)}, 'changed')`);
    const changed = await openCard(first);
    await screenshot('7a-file-menu.png');
    report.checks.fileMenu = {
      clean,
      changed,
      diffHiddenWhenClean: clean.open && !clean.items.includes('View diff'),
      diffShownWhenChanged: changed.open && changed.items.includes('View diff'),
      cardMatchesHover: changed.path === changed.hovered,
      ringOnFile: changed.selected >= 0,
      escapeClosedCard: !afterCardEscape.open && afterCardEscape.selected === -1,
      escapeKeptCamera: afterCardEscape.focus === clean.focus,
    };

    // Attach to prompt: the card closes and the drawer opens with the file as a chip; the chip and the drawer are put away again.
    await clickOn('.file-menu .fm-item-attach');
    await sleep(600);
    const attached = await evaluate(`({ menuOpen: __orbit.fileMenu().open, drawerOpen: document.querySelector('.drawer').dataset.open === 'true', chips: [...document.querySelectorAll('.drawer .file-chip')].map((chip) => chip.dataset.path) })`);
    report.checks.fileMenu.attach = { ...attached, ok: !attached.menuOpen && attached.drawerOpen && attached.chips.length === 1 && attached.chips[0] === changed.path };
    await evaluate(`document.querySelector('.drawer .file-chip-remove')?.click()`);
    await key('Escape', 'Escape', 27);
    await sleep(500);
    await openCard(first);

    const writesBefore = (await evaluate('__host.files.writes')).length;
    await clickOn('.file-menu .fm-item-open');
    await waitFor(evaluate, '__orbit.editor().open && __orbit.editor().text !== undefined', 5_000);
    await sleep(600);
    const opened = await evaluate('__orbit.editor()');
    await screenshot('7b-editor.png');
    await chord('End', 'End', 35, mod);
    await cdp.send('Input.insertText', { text: '// typed in the harness\n' });
    await sleep(250);
    const typed = await evaluate('__orbit.editor()');
    await chord('s', 'KeyS', 83, mod);
    await sleep(500);
    const saved = await evaluate(`({ editor: __orbit.editor(), writes: __host.files.writes })`);
    await clickOn('.editor-sheet .es-mode + .es-mode');
    await sleep(700);
    const diff = await evaluate('__orbit.editor()');
    await screenshot('7c-diff.png');
    const outsideSent = await evaluate('__host.outside()');
    await sleep(500);
    const afterOutside = await evaluate('__orbit.editor()');
    const focusBeforeSheetEscape = await evaluate('__orbit.world().focus.cluster');
    await key('Escape', 'Escape', 27);
    await sleep(700);
    const afterSheetEscape = await evaluate(`({ editor: __orbit.editor(), focus: __orbit.world().focus.cluster, tabHidden: document.querySelector('.hud').dataset.editorOpen })`);
    report.checks.editor = {
      opened: opened.open && opened.path === changed.path && typeof opened.text === 'string' && opened.text.length > 0,
      language: opened.language,
      dirtyAfterTyping: typed.dirty,
      savedWithShortcut: !saved.editor.dirty && saved.writes.length === writesBefore + 1 && saved.writes.at(-1)?.text.includes('typed in the harness'),
      changesShown: diff.mode === 'changes' && diff.changes > 0,
      changes: diff.changes,
      outsideChangeTaken: outsideSent && !!afterOutside.text?.includes('changed elsewhere') && !afterOutside.dirty,
      closedByEscape: !afterSheetEscape.editor.open,
      cameraStayed: afterSheetEscape.focus === focusBeforeSheetEscape,
      bottomHudBack: afterSheetEscape.tabHidden === 'false',
    };

    const renameCard = await openCard(second);
    const renameFrom = { index: renameCard.selected, xyz: await evaluate(`(() => { const w = __orbit.world(); const p = w.layout.positions; const i = w.selected; return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]; })()`), files: await evaluate('__orbit.world().graph.nodes.count') };
    await clickOn('.file-menu .fm-item-rename');
    await sleep(500);
    const renamePrompt = await evaluate(`({ view: document.querySelector('.file-menu').dataset.view, value: document.querySelector('.fm-input').value, focused: document.activeElement === document.querySelector('.fm-input'), selected: [document.querySelector('.fm-input').selectionStart, document.querySelector('.fm-input').selectionEnd] })`);
    await cdp.send('Input.insertText', { text: 'renamedByHarness' });
    await sleep(200);
    renamePrompt.detail = await evaluate(`document.querySelector('.fm-rename .fm-detail').textContent`);
    await screenshot('7d-rename.png');
    await key('Enter', 'Enter', 13);
    await sleep(1600);
    const renamed = await evaluate(`(() => {
      const w = __orbit.world(); const n = w.graph.nodes; const p = w.layout.positions;
      const ids = Array.from({ length: n.count }, (_, i) => n.dirs[n.dirIndex[i]] === '.' ? n.names[i] : n.dirs[n.dirIndex[i]] + '/' + n.names[i]);
      const log = __host.files.renamed.at(-1);
      const at = log ? ids.indexOf(log.to) : -1;
      return { log, files: n.count, oldGone: !!log && !ids.includes(log.from), xyz: at >= 0 ? [p[at * 3], p[at * 3 + 1], p[at * 3 + 2]] : null, menuOpen: __orbit.fileMenu().open };
    })()`);
    await screenshot('7e-renamed.png');
    report.checks.rename = {
      prompt: renamePrompt,
      nameSelectedWithoutExtension: renamePrompt.focused && renamePrompt.selected[0] === 0 && renamePrompt.selected[1] > 0 && renamePrompt.selected[1] <= renamePrompt.value.length,
      log: renamed.log,
      fileCountKept: renamed.files === renameFrom.files,
      oldNameGone: renamed.oldGone,
      keptPosition: !!renamed.xyz && renamed.xyz.every((v, k) => Math.abs(v - renameFrom.xyz[k]) < 1e-4),
      cardClosed: !renamed.menuOpen,
    };

    const deleteCard = await openCard(third);
    const doomedFiles = await evaluate('__orbit.world().graph.nodes.count');
    await clickOn('.file-menu .fm-item-delete');
    await sleep(150);
    const confirmEarly = await evaluate(`({ view: document.querySelector('.file-menu').dataset.view, disarmed: document.querySelector('.fm-confirm .fm-go').disabled, tone: __orbit.world().uniforms.uSelectTone.value })`);
    await sleep(550);
    await screenshot('7f-confirm-delete.png');
    const armed = await evaluate(`!document.querySelector('.fm-confirm .fm-go').disabled`);
    await clickOn('.fm-confirm .fm-go');
    await sleep(220);
    const collapsing = await evaluate(`({ menuOpen: __orbit.fileMenu().open, rendering: __orbit.debug.rendering, logged: __host.files.deleted.includes(${JSON.stringify(deleteCard.path)}) })`);
    await screenshot('7g-deleting.png');
    await sleep(1400);
    const deleted = await evaluate(`(() => {
      const w = __orbit.world(); const n = w.graph.nodes;
      const ids = Array.from({ length: n.count }, (_, i) => n.dirs[n.dirIndex[i]] === '.' ? n.names[i] : n.dirs[n.dirIndex[i]] + '/' + n.names[i]);
      return { files: n.count, gone: !ids.includes(${JSON.stringify(deleteCard.path)}) };
    })()`);
    report.checks.delete = {
      path: deleteCard.path,
      confirmShown: confirmEarly.view === 'confirm',
      armsAfterDelay: confirmEarly.disarmed && armed,
      ringTurnedRed: confirmEarly.tone === 1,
      hostDeleted: collapsing.logged,
      cardClosed: !collapsing.menuOpen,
      animating: collapsing.rendering,
      removedFromGraph: deleted.gone && deleted.files === doomedFiles - 1,
    };
  } else {
    report.checks.fileMenu = {
      error: `only ${fileSpots.length} files projected clear of the HUD in ${fileHome.label}`,
      seen: await evaluate(`(() => {
        const w = __orbit.world(); const pos = w.layout.positions; const focus = w.focus.cluster;
        const inFocus = []; for (let i = 0; i < w.graph.nodes.count; i++) if (w.layout.clusterOf[i] === focus) inFocus.push(i);
        return {
          focus: w.layout.clusters.labels[focus], opened: w.layout.clusters.labels[w.focus.opened], animating: w.focus.animating, filesInFocus: inFocus.length,
          projected: inFocus.slice(0, 6).map((i) => { const p = __orbit.project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); return [Math.round(p.x), Math.round(p.y), +p.depth.toFixed(3)]; }),
          viewport: [innerWidth, innerHeight],
        };
      })()`),
    };
  }
  report.checks.fileMenuDirectory = { label: fileHome.label, tried: fileHome.tried };
  // Back where the view was (the root, where the zoom and drill-in start), found by label: the rename and the delete may have moved cluster indices.
  await evaluate(`(() => { const w = __orbit.world(); const c = w.layout.clusters.labels.indexOf(${JSON.stringify(fileHome.back)}); if (c >= 0) w.goTo(c); })()`);
  await mouse('mouseMoved', 6, 6);
  await sleep(300);
  await waitFor(evaluate, '!__orbit.world().focus.animating', 10_000);
  await sleep(300);

  // Zoom instead of clicks: scrolling in over a bubble reveals its contents gradually and opens it without a click,
  // and scrolling back out closes it again.
  const zoomTarget = await bubbleTarget();
  if (zoomTarget) {
    const state = () => evaluate(`(() => { const w = __orbit.world(); const u = w.uniforms; return { shown: w.focus.cluster, open: w.focus.opened, inner: u.uFocus.value, mix: +u.uFocusMix.value.toFixed(3) }; })()`);
    const wheel = (deltaY) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: zoomTarget.x, y: zoomTarget.y, deltaX: 0, deltaY });
    const outside = (await state()).open;
    await mouse('mouseMoved', zoomTarget.x, zoomTarget.y);
    const reveal = [];
    let opened = false;
    let midShot = false;
    for (let k = 0; k < 90 && !opened; k++) {
      await wheel(-100);
      await sleep(110);
      const now = await state();
      if (now.inner === zoomTarget.cluster && now.mix > 0 && now.mix < 1) {
        reveal.push(now.mix);
        if (!midShot && now.mix >= 0.35) {
          midShot = true;
          await screenshot('1c-zoom-reveal.png');
        }
      }
      opened = now.open === zoomTarget.cluster;
    }
    await sleep(400);
    const inside = await location();
    await screenshot('1d-zoom-opened.png');
    let closed = false;
    for (let k = 0; k < 90 && !closed; k++) {
      await wheel(100);
      await sleep(110);
      closed = (await state()).open === outside;
    }
    await sleep(400);
    report.checks.zoom = {
      aimedAt: zoomTarget.name,
      revealSteps: reveal.length,
      revealRises: reveal.length >= 2 && reveal.every((mix, k) => k === 0 || mix >= reveal[k - 1]),
      reveal: reveal.slice(0, 10),
      openedWithoutClick: opened,
      breadcrumbPath: inside.breadcrumbPath,
      closedByZoomingOut: closed,
    };
  }

  // Look into a directory bubble at the root, then into a bubble inside that one: exercises the GPU id pass at two levels.
  const target = await bubbleTarget();
  if (target) {
    report.checks.drill = await drillInto(target, '2-drilled-in.png');
    report.checks.hoverCluster = { aimedAt: report.checks.drill.aimedAt, tooltip: report.checks.drill.tooltip };
    const firstLevel = await location();

    const deeper = await bubbleTarget();
    if (deeper) {
      report.checks.drillDeeper = await drillInto(deeper, '2b-drilled-deeper.png');
      // The breadcrumb leads back up a level; the same bubble then leads back in, as the camera returns to the same fit.
      const link = await evaluate(`(() => {
        const buttons = document.querySelectorAll('.crumbs button');
        const r = buttons[buttons.length - 1]?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, text: buttons[buttons.length - 1].textContent } : null;
      })()`);
      if (link) {
        await click(link.x, link.y);
        await sleep(1200);
        const back = await location();
        await click(deeper.x, deeper.y);
        await sleep(1400);
        const again = await location();
        report.checks.breadcrumb = { clicked: link.text, backToParent: back.focus === firstLevel.focus, inAgain: again.focus === deeper.cluster };
      }
    }

    // Hover a file directly inside the directory being looked into.
    const file = await evaluate(`(() => {
      const w = __orbit.world(); const focus = w.focus.cluster; const pos = w.layout.positions;
      for (let i = 0; i < w.graph.nodes.count; i++) {
        if (w.layout.clusterOf[i] !== focus) continue;
        const p = __orbit.project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        // Clear of the Claude bubbles and the drawer tab along the bottom edge.
        if (p.x > 40 && p.y > 160 && p.x < innerWidth - 40 && p.y < innerHeight - 90) return { index: i, x: p.x, y: p.y };
      }
      return null;
    })()`);
    if (file) {
      await mouse('mouseMoved', file.x, file.y);
      await sleep(500);
      report.checks.hoverFile = { tooltip: await tooltipTitle() };
      await screenshot('3-hover-file.png');
    }

    // Live update while looking into a directory: a file joins it (or the directory of one of its files), a new
    // sub-directory appears inside it, one lands in a new top-level directory, and a file elsewhere goes.
    // The World must be replaced in place: same focus, no layout run, animation still at 30 fps.
    const plan = await evaluate(`(() => {
      const w = __orbit.world(); const n = w.graph.nodes; const focus = w.focus.cluster; const labels = w.layout.clusters.labels;
      const id = (i) => n.dirs[n.dirIndex[i]] === '.' ? n.names[i] : n.dirs[n.dirIndex[i]] + '/' + n.names[i];
      const inside = (c) => { for (; c >= 0; c = w.view.parent[c]) if (c === focus) return true; return false; };
      const sizes = new Map();
      for (let i = 0; i < n.count; i++) sizes.set(w.layout.clusterOf[i], (sizes.get(w.layout.clusterOf[i]) ?? 0) + 1);
      let direct = -1, below = -1, elsewhere = -1;
      for (let i = 0; i < n.count; i++) {
        const c = w.layout.clusterOf[i];
        if (c === focus && direct < 0) direct = i;
        if (inside(c) && below < 0) below = i;
        if (!inside(c) && sizes.get(c) > 1) elsewhere = i;
      }
      const inFocus = direct >= 0 ? direct : below;
      const prefix = labels[focus] === '.' ? '' : labels[focus] + '/';
      const dir = n.dirs[n.dirIndex[inFocus]];
      return {
        focus: labels[focus],
        files: n.count,
        newBubble: prefix + '__harness_sub',
        add: [
          { id: (dir === '.' ? '' : dir + '/') + '__harness_added.ts', imports: [id(inFocus)] },
          { id: prefix + '__harness_sub/inner.ts', imports: [id(inFocus)] },
          { id: '__harness_new/entry.ts', imports: [id(inFocus)] },
        ],
        remove: elsewhere >= 0 ? [id(elsewhere)] : [],
      };
    })()`);
    const before = await location();
    const layoutsBefore = (await evaluate('__host.received')).filter((type) => type === 'layoutComputed').length;
    const logsBefore = (await evaluate('__host.logs')).length;
    const updatesBefore = await evaluate('__orbit.debug.updates');
    // Lines are firing when the update lands: the new World must carry the burst on, not restart or drop it.
    await evaluate('__host.think()');
    await sleep(400);
    const burstBefore = await evaluate(`(() => { const u = __orbit.world().uniforms; return [u.uThinkStart.value, u.uThinkEnd.value]; })()`);
    const sent = await evaluate(`__host.update(${JSON.stringify({ add: plan.add, remove: plan.remove })})`);
    await sleep(700);
    const after = await evaluate(`(() => {
      const w = __orbit.world(); const n = w.graph.nodes; const labels = w.layout.clusters.labels;
      const ids = new Set(Array.from({ length: n.count }, (_, i) => n.dirs[n.dirIndex[i]] === '.' ? n.names[i] : n.dirs[n.dirIndex[i]] + '/' + n.names[i]));
      const bubble = labels.indexOf(${JSON.stringify(plan.newBubble)});
      return {
        hash: w.graph.hash,
        files: n.count,
        focus: labels[w.focus.cluster],
        breadcrumb: document.querySelector('.crumb-current').textContent,
        added: ${JSON.stringify(plan.add.map((file) => file.id))}.filter((id) => ids.has(id)),
        removedGone: ${JSON.stringify(plan.remove)}.every((id) => !ids.has(id)),
        newBubbleShown: bubble >= 0 && w.view.shown[bubble] === 1 && w.view.viewParent[bubble] === w.focus.cluster,
        updates: __orbit.debug.updates,
        updateMs: __orbit.debug.updateMs,
        burst: [w.uniforms.uThinkStart.value, w.uniforms.uThinkEnd.value],
      };
    })()`);
    const updateLogs = (await evaluate('__host.logs')).slice(logsBefore);
    await screenshot('3b-after-update.png');
    await evaluate(`__host.play('After the live update')`);
    await sleep(1000);
    const u0 = await evaluate('__orbit.debug.frames');
    await sleep(3000);
    const u1 = await evaluate('__orbit.debug.frames');
    await evaluate('__host.pause()');
    report.checks.liveUpdate = {
      sent,
      focusBefore: plan.focus,
      focusAfter: after.focus,
      stillDrilledIn: after.focus === plan.focus && after.breadcrumb === before.breadcrumb,
      filesBefore: plan.files,
      filesAfter: after.files,
      nodeCountChanged: after.files === plan.files + plan.add.length - plan.remove.length,
      addedInWorld: after.added.length === plan.add.length,
      removedGone: after.removedGone,
      newBubbleShown: after.newBubbleShown,
      appliedInPlace: after.updates === updatesBefore + 1 && after.hash === sent.hash,
      firingCarriedOver: burstBefore[1] > 0 && after.burst[0] === burstBefore[0] && after.burst[1] === burstBefore[1],
      worldRebuildMs: +after.updateMs.toFixed(2),
      newLayoutComputed: (await evaluate('__host.received')).filter((type) => type === 'layoutComputed').length - layoutsBefore,
      newLayoutLogs: updateLogs.filter((line) => line.includes('layout of')).length,
      measuredFpsAfter: +((u1 - u0) / 3).toFixed(1),
      logs: updateLogs,
    };
    await sleep(300);

    // Esc backs out one level at a time, to the root.
    const steps = [];
    for (let k = 0; k < 8; k++) {
      const here = await evaluate(`(() => { const w = __orbit.world(); return { focus: w.focus.cluster, parent: w.view.viewParent[w.focus.cluster], root: w.view.root, label: w.layout.clusters.labels[w.focus.cluster] }; })()`);
      if (here.focus === here.root) break;
      await key('Escape', 'Escape', 27);
      await sleep(1100);
      steps.push({ from: here.label, upOneLevel: (await evaluate('__orbit.world().focus.cluster')) === here.parent });
    }
    const atRoot = await evaluate('__orbit.world().focus.cluster === __orbit.world().view.root');
    report.checks.escape = { steps, upOneLevelEachTime: steps.length > 0 && steps.every((step) => step.upOneLevel), backAtRoot: atRoot };
    report.checks.escapeToOverview = atRoot;
  } else {
    report.checks.hoverCluster = { error: 'no large bubble projected clear of the HUD' };
  }

  // Drawer: drag the Claude tab up, type a prompt and press Enter. The sheet closes as the prompt flies into a new Claude
  // bubble; hovering the bubble says what it is doing, clicking it opens the session view (Markdown, Stop, a permission
  // card answered with a real click), and Esc folds it back. The bubble leaves once the turn is done.
  const prompt = 'Where does the layout get cached?';
  const tab = await evaluate(`(() => { const r = document.querySelector('.drawer-tab').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 12 }; })()`);
  await mouse('mousePressed', tab.x, tab.y);
  for (let k = 1; k <= 10; k++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tab.x, y: tab.y - k * 24, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await mouse('mouseReleased', tab.x, tab.y - 240);
  await sleep(600);
  const drawerOpened = await evaluate(`document.querySelector('.drawer').dataset.open === 'true' && document.activeElement === document.querySelector('.drawer .composer-input')`);
  await screenshot('4a-drawer-open.png');
  await cdp.send('Input.insertText', { text: prompt });
  await key('Enter', 'Enter', 13);
  await sleep(240);
  const inFlight = await evaluate(`({ launching: !!document.querySelector('.launch'), sheetOpen: document.querySelector('.drawer').dataset.open === 'true', input: document.querySelector('.drawer .composer-input').value })`);
  await screenshot('4b-launch.png');
  await sleep(900);
  const landed = await evaluate(`(() => {
    const b = document.querySelector('.claude-bubble');
    if (!b) return null;
    const r = b.querySelector('.claude-bubble-button').getBoundingClientRect();
    return { phase: b.dataset.phase, title: b.querySelector('.claude-bubble-title').textContent, x: r.left + r.width / 2, y: r.top + r.height / 2, launchGone: !document.querySelector('.launch') };
  })()`);
  let hover = null;
  let view = null;
  if (landed) {
    await mouse('mouseMoved', landed.x, landed.y);
    await sleep(550);
    hover = await evaluate(`(() => { const l = document.querySelector('.claude-bubble-label'); return { shown: getComputedStyle(l).opacity === '1', title: l.querySelector('.claude-bubble-title').textContent, detail: l.querySelector('.claude-bubble-detail').textContent }; })()`);
    await screenshot('4c-bubble-hover.png');
    await click(landed.x, landed.y);
    await sleep(700);
    view = await evaluate(`({ open: !document.querySelector('.session-view').hidden, title: document.querySelector('.sv-title').textContent, action: document.querySelector('.sv-footer .composer-action').textContent })`);
    await screenshot('4d-session-view.png');
    await evaluate(`__host.ask('Bash', 'npm run build')`);
    await sleep(300);
    const allow = await evaluate(`(() => {
      const card = document.querySelector('.permission'); const r = card.querySelector('.button.primary').getBoundingClientRect();
      const always = card.querySelector('.permission-always');
      return { card: !card.hidden, always: !always.hidden && always.textContent, bubble: document.querySelector('.claude-bubble').dataset.phase, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await screenshot('4e-permission.png');
    await click(allow.x, allow.y);
    await sleep(300);
    view.permission = { cardShown: allow.card, alwaysOffered: allow.always, bubbleWaiting: allow.bubble === 'waiting', answered: await evaluate(`document.querySelector('.permission').hidden && !__host.state().permission`) };
    // Claude's questions (AskUserQuestion): the question card in place of the permission card, Answer armed only once
    // every question has one, a multi-select pick and a single-choice pick reaching the host by question text.
    await evaluate(`__host.askQuestions()`);
    await sleep(300);
    const optionAt = (question, label) =>
      evaluate(`(() => { const b = [...document.querySelectorAll('.question .q-item')][${question}]?.querySelector('.q-option[data-label="${label}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const asked = await evaluate(`(() => { const card = document.querySelector('.question'); return { shown: !card.hidden, permissionHidden: document.querySelector('.permission').hidden, items: card.querySelectorAll('.q-item').length, answerDisabled: card.querySelector('.question-actions .button.primary').disabled }; })()`);
    for (const [question, label] of [[0, 'Harness'], [0, 'Typecheck'], [1, 'The webview']]) {
      const at = await optionAt(question, label);
      if (at) await click(at.x, at.y);
      await sleep(120);
    }
    await screenshot('4e2-questions.png');
    const armed = await evaluate(`(() => { const b = document.querySelector('.question-actions .button.primary'); const r = b.getBoundingClientRect(); return { disabled: b.disabled, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!armed.disabled) await click(armed.x, armed.y);
    await sleep(300);
    view.questions = {
      cardShown: asked.shown && asked.permissionHidden && asked.items === 2,
      answerDisabledUntilAnswered: asked.answerDisabled,
      answerArmed: !armed.disabled,
      answered: await evaluate(`JSON.stringify(__host.answered.at(-1)) === JSON.stringify({ 'Which checks should run?': 'Typecheck, Harness', 'Where should the change go?': 'The webview' })`),
      cardClosed: await evaluate(`document.querySelector('.question').hidden && !__host.state().permission`),
    };
    await key('Escape', 'Escape', 27);
    await sleep(500);
    view.closedByEscape = await evaluate(`document.querySelector('.session-view').hidden`);
    view.bubbleBack = await evaluate(`getComputedStyle(document.querySelector('.claude-bubbles')).visibility === 'visible'`);
  }
  await waitFor(evaluate, `__host.state().phase === 'idle'`, 10_000);
  await sleep(300);
  await screenshot('4-prompt-turn.png');
  report.checks.promptRoundTrip = {
    drawerOpenedByDrag: drawerOpened,
    sheetClosedOnSend: !inFlight.sheetOpen,
    launchInFlight: inFlight.launching,
    hostReceived: (await evaluate('__host.prompts')).includes(prompt),
    inputCleared: inFlight.input === '',
    bubble: landed,
    hover,
    view,
    actionWhileWorking: view?.action,
    bubbleLeftAfterTurn: await waitFor(evaluate, `!document.querySelector('.claude-bubble')`, 6_000),
    transcriptPrompt: await evaluate(`[...document.querySelectorAll('.transcript .t-prompt')].at(-1)?.textContent`),
  };

  // Two conversations at once: a prompt sent from the drawer while the first one's turn runs starts another beside it.
  // Each has its own bubble and its own star; a bubble opens its own transcript; both leave once their turns end.
  await waitFor(evaluate, `__host.state().phase === 'idle'`, 10_000);
  const tabAt = async () => evaluate(`(() => { const r = document.querySelector('.drawer-tab').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 20 }; })()`);
  const centreOf = (selector) => evaluate(`(() => { const e = document.querySelector('${selector}'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const sendFromDrawer = async (text) => {
    const tab = await tabAt();
    await click(tab.x, tab.y);
    await sleep(500);
    await cdp.send('Input.insertText', { text });
    await key('Enter', 'Enter', 13);
  };
  const firstPrompt = 'Explain the layout worker';
  const secondPrompt = 'List the indexer entry points';
  await sendFromDrawer(firstPrompt);
  await sleep(1200);
  const drawerWhileBusy = await evaluate(`(() => { const tab = document.querySelector('.drawer-tab').getBoundingClientRect(); return { x: tab.left + tab.width / 2, y: tab.top + 20 }; })()`);
  await click(drawerWhileBusy.x, drawerWhileBusy.y);
  await sleep(500);
  const composerWhileBusy = await evaluate(`({ open: document.querySelector('.drawer').dataset.open === 'true', inputEnabled: !document.querySelector('.drawer .composer-input').disabled, context: document.querySelector('.sheet-context-text').textContent })`);
  await cdp.send('Input.insertText', { text: secondPrompt });
  await key('Enter', 'Enter', 13);
  // The second conversation's star appears with its first file read, a couple of steps into its turn.
  await waitFor(evaluate, '__orbit.world().claudeStars === 2', 5000);
  await sleep(300);
  await screenshot('4f-two-sessions.png');
  const twoSessions = await evaluate(`(() => {
    const bubbles = [...document.querySelectorAll('.claude-bubble')].map((b) => ({ phase: b.dataset.phase, title: b.querySelector('.claude-bubble-title').textContent }));
    const { states, current } = __host.sessions();
    return { bubbles, hostStates: states.map((s) => ({ key: s.key, phase: s.phase })), current, stars: __orbit.world().claudeStars };
  })()`);
  const secondBubble = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.claude-bubble')].find((el) => el.querySelector('.claude-bubble-title').textContent === ${JSON.stringify(secondPrompt)});
    if (!b) return null;
    const r = b.querySelector('.claude-bubble-button').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  let secondView = null;
  if (secondBubble) {
    await click(secondBubble.x, secondBubble.y);
    await sleep(700);
    secondView = await evaluate(`({ open: !document.querySelector('.session-view').hidden, title: document.querySelector('.sv-title').textContent, prompts: [...document.querySelectorAll('.transcript .t-prompt')].map((p) => p.textContent) })`);
    await screenshot('4g-second-session-view.png');
    await key('Escape', 'Escape', 27);
    await sleep(500);
  }
  const bothEnded = await waitFor(evaluate, `__host.sessions().states.every((s) => s.phase === 'idle')`, 15_000);
  report.checks.parallelSessions = {
    composerOpenWhileBusy: composerWhileBusy,
    secondPromptReached: (await evaluate('__host.prompts')).includes(secondPrompt),
    whileBothRun: twoSessions,
    twoBubbles: twoSessions.bubbles.length === 2 && twoSessions.bubbles.every((b) => b.phase === 'working'),
    twoConversationsWorking: twoSessions.hostStates.filter((s) => s.phase === 'working').length === 2,
    twoStars: twoSessions.stars === 2,
    secondView,
    secondViewOwnTranscript: secondView?.open === true && secondView.title === secondPrompt && secondView.prompts.length === 1 && secondView.prompts[0] === secondPrompt,
    bothEnded,
    bubblesLeft: await waitFor(evaluate, `!document.querySelector('.claude-bubble')`, 8_000),
    starsBackToOne: await waitFor(evaluate, `__orbit.world().claudeStars === 1`, 8_000),
  };

  // Skills: the model picker lists what the catalog offers; the Skills toggle opens the constellation, a tesseract per skill;
  // a real drag carries one out of the panel onto the composer, where it becomes a chip that goes with the prompt.
  await waitFor(evaluate, `__host.state().phase === 'idle'`, 10_000);
  let at = await tabAt();
  await click(at.x, at.y);
  await sleep(600);
  const models = await evaluate(`[...document.querySelector('.drawer .composer-select').options].map((option) => option.textContent)`);

  // Effort: a click on a bar picks that level and reaches the host, an arrow key moves it, a model that takes no effort
  // level (Haiku, as 2.1.267 reports it) dims the meter and keeps the pick, and the ring goes back to Claude Code's default.
  const effortState = `(() => { const m = document.querySelector('.drawer .composer-effort'); return { level: m.dataset.level, offered: m.dataset.offered, lit: m.querySelectorAll('.effort-bar[data-lit="true"]').length, checked: m.querySelector('[aria-checked="true"]')?.dataset.effort ?? null, host: __host.state().options.effort, disabled: [...m.querySelectorAll('.effort-bar')].every((bar) => bar.disabled) }; })()`;
  const pickModel = (value) => evaluate(`(() => { const s = document.querySelector('.drawer .composer-select'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
  const effortInitial = await evaluate(effortState);
  at = await centreOf('.drawer .effort-bar[data-effort="high"]');
  await click(at.x, at.y);
  await sleep(600);
  const effortClicked = await evaluate(effortState);
  await screenshot('6i-effort.png');
  await key('ArrowRight', 'ArrowRight', 39);
  await sleep(400);
  const effortKeyboard = await evaluate(effortState);
  await pickModel('haiku');
  await sleep(400);
  const effortHaiku = await evaluate(effortState);
  await screenshot('6j-effort-not-offered.png');
  await pickModel('');
  await sleep(400);
  at = await centreOf('.drawer .effort-auto');
  await click(at.x, at.y);
  await sleep(400);
  const effortBack = await evaluate(effortState);
  await evaluate(`document.querySelector('.drawer .composer-input').focus()`);
  report.checks.effort = {
    initial: effortInitial,
    haiku: effortHaiku,
    pickedByClick: effortClicked.level === 'high' && effortClicked.checked === 'high' && effortClicked.host === 'high' && effortClicked.lit === 3,
    pickedByKey: effortKeyboard.level === 'xhigh' && effortKeyboard.host === 'xhigh' && effortKeyboard.lit === 4,
    dimmedForHaiku: effortHaiku.offered === 'false' && effortHaiku.disabled && effortHaiku.host === 'xhigh',
    backToAuto: effortBack.level === 'auto' && effortBack.checked === '' && effortBack.host === '' && effortBack.lit === 0,
  };
  at = await centreOf('.drawer .composer-toggle[data-kind="skills"]');
  await click(at.x, at.y);
  await sleep(2600);
  const skillsOpen = await evaluate(`({ ...__orbit.constellation(), nodes: document.querySelectorAll('.skill-node').length, shown: document.querySelectorAll('.skill-node[data-shown="true"]').length, pressed: document.querySelector('.drawer .composer-toggle[data-kind="skills"]').getAttribute('aria-pressed') })`);
  await screenshot('6a-skills.png');
  const grab = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.skill-node[data-shown="true"]')];
    const node = nodes.find((n) => n.dataset.skill === 'graph-pipeline') ?? nodes[0];
    if (!node) return null;
    const r = node.getBoundingClientRect(); const input = document.querySelector('.drawer .composer-input').getBoundingClientRect();
    return { skill: node.dataset.skill, x: r.left + r.width / 2, y: r.top + r.height / 2, tx: input.left + input.width * 0.4, ty: input.top + input.height / 2 };
  })()`);
  let skillDrag = null;
  if (grab) {
    await mouse('mouseMoved', grab.x, grab.y);
    await sleep(250);
    await mouse('mousePressed', grab.x, grab.y);
    for (let k = 1; k <= 16; k++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grab.x + ((grab.tx - grab.x) * k) / 16, y: grab.y + ((grab.ty - grab.y) * k) / 16, button: 'left', buttons: 1 });
      await sleep(24);
    }
    await sleep(120);
    const midDrag = await evaluate(`({ drop: document.querySelector('.drawer .composer').dataset.drop ?? null, label: !document.querySelector('.skill-drag-label').hidden })`);
    await screenshot('6b-skill-drag.png');
    await mouse('mouseReleased', grab.tx, grab.ty);
    await sleep(700);
    skillDrag = { skill: grab.skill, overComposer: midDrag.drop === 'over', dragLabel: midDrag.label, chips: await evaluate(`[...document.querySelectorAll('.drawer .skill-chip')].map((chip) => chip.dataset.skill)`) };
    await screenshot('6c-skill-attached.png');
    await cdp.send('Input.insertText', { text: 'Use the attached skill' });
    await key('Enter', 'Enter', 13);
    await sleep(500);
    skillDrag.sent = await evaluate('__host.skillPrompts.at(-1)');
    skillDrag.chipsClearedOnSend = await evaluate(`document.querySelectorAll('.drawer .skill-chip').length === 0`);
    await waitFor(evaluate, `__host.state().phase === 'idle'`, 12_000);
    await sleep(400);
  }
  report.checks.skills = { models, open: skillsOpen, drag: skillDrag };

  // Files: the composer's Files button asks the host's open dialog (hostSim answers with a graph file and a path outside the
  // workspace); both become chips that go out with the prompt, and the transcript names them, linking only the workspace one.
  at = await tabAt();
  await click(at.x, at.y);
  await sleep(600);
  const filesButton = await centreOf('.drawer .composer-toggle[data-kind="files"]');
  let attachments = null;
  if (filesButton) {
    await click(filesButton.x, filesButton.y);
    await sleep(700);
    const chips = await evaluate(`[...document.querySelectorAll('.drawer .file-chip')].map((chip) => chip.dataset.path)`);
    await screenshot('6k-files-attached.png');
    await cdp.send('Input.insertText', { text: 'Read the attached files' });
    await key('Enter', 'Enter', 13);
    await sleep(900);
    attachments = {
      pickAsked: (await evaluate('__host.received')).includes('pickFiles'),
      chips,
      sent: await evaluate('__host.skillPrompts.at(-1)'),
      chipsClearedOnSend: await evaluate(`document.querySelectorAll('.drawer .file-chip').length === 0`),
      inTranscript: await evaluate(`[...document.querySelectorAll('.transcript .t-prompt')].at(-1)?.querySelectorAll('.t-attached').length ?? 0`),
      linked: await evaluate(`[...document.querySelectorAll('.transcript .t-prompt')].at(-1)?.querySelectorAll('.t-attached[data-file]').length ?? 0`),
    };
    attachments.ok = chips.length === 2 && attachments.sent?.files?.length === 2 && attachments.chipsClearedOnSend && attachments.inTranscript === 2 && attachments.linked === 1;
    await waitFor(evaluate, `__host.state().phase === 'idle'`, 12_000);
    await sleep(400);
  }
  report.checks.files = attachments;

  // A slash typed in the composer opens the Skills constellation narrowed to the text after it; the wheel over the field
  // zooms it in; Enter attaches the picked skill in place of the typed command and the panel goes.
  at = await tabAt();
  await click(at.x, at.y);
  await sleep(600);
  await cdp.send('Input.insertText', { text: '/gra' });
  await sleep(1400);
  const slashOpen = await evaluate(`({ ...__orbit.constellation(), shown: [...document.querySelectorAll('.skill-node[data-shown="true"]')].map((n) => n.dataset.skill), pressed: document.querySelector('.drawer .composer-toggle[data-kind="skills"]').getAttribute('aria-pressed'), sub: document.querySelector('.constellation-sub').textContent })`);
  await screenshot('6g-slash.png');
  const fieldAt = await centreOf('.constellation-field');
  let slashZoom = null;
  if (fieldAt) {
    for (let k = 0; k < 6; k++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: fieldAt.x, y: fieldAt.y, deltaX: 0, deltaY: -120 });
      await sleep(40);
    }
    await sleep(700);
    slashZoom = await evaluate(`({ zoom: __orbit.constellation().zoom, fit: !document.querySelector('.constellation-fit').hidden, labelScale: getComputedStyle(document.querySelector('.constellation-field')).getPropertyValue('--label-scale').trim(), graphUnmoved: true })`);
    await screenshot('6h-slash-zoomed.png');
  }
  await key('Enter', 'Enter', 13);
  await sleep(500);
  const slashPicked = await evaluate(`({ chips: [...document.querySelectorAll('.drawer .skill-chip')].map((chip) => chip.dataset.skill), input: document.querySelector('.drawer .composer-input').value, constellationClosed: !__orbit.constellation().mode, drawerOpen: document.querySelector('.drawer').dataset.open === 'true' })`);
  report.checks.slash = { open: slashOpen, zoom: slashZoom, picked: slashPicked };
  await evaluate(`document.querySelector('.drawer .skill-chip-remove')?.click()`);
  await key('Escape', 'Escape', 27);
  await sleep(500);

  // The session view's composer: while a turn runs, a reply is written, a model picked and files and a skill attached to it,
  // with Stop in place of Send and Enter stopping nothing; the skills panel opens over the view, and Esc closes it before the
  // view. Once the turn ends, Enter sends it all to that conversation.
  await waitFor(evaluate, `__host.state().phase === 'idle'`, 10_000);
  const viewPrompt = 'Walk through the reply composer';
  const viewReply = 'Now check the attached files';
  await sendFromDrawer(viewPrompt);
  await sleep(1300);
  const viewKey = await evaluate('__host.sessions().current');
  const viewBubble = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.claude-bubble')].find((el) => el.querySelector('.claude-bubble-title').textContent === ${JSON.stringify(viewPrompt)});
    if (!b) return null;
    const r = b.querySelector('.claude-bubble-button').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  let viewComposer = null;
  if (viewBubble) {
    const composerState = `(() => {
      const view = document.querySelector('.session-view'); const c = view.querySelector('.sv-footer'); const input = c.querySelector('.composer-input');
      return { open: !view.hidden, phase: __host.sessions().states.find((s) => s.key === ${JSON.stringify(viewKey)})?.phase, inputEnabled: !input.disabled, focused: document.activeElement === input,
        modelEnabled: !c.querySelector('.composer-select').disabled, action: c.querySelector('.composer-action').textContent, input: input.value,
        skills: [...c.querySelectorAll('.skill-chip')].map((chip) => chip.dataset.skill), files: [...c.querySelectorAll('.file-chip')].map((chip) => chip.dataset.path) };
    })()`;
    await click(viewBubble.x, viewBubble.y);
    await sleep(700);
    const working = await evaluate(composerState);
    await cdp.send('Input.insertText', { text: viewReply });
    await key('Enter', 'Enter', 13);
    await sleep(250);
    const afterEnter = await evaluate(composerState);
    await evaluate(`(() => { const s = document.querySelector('.session-view .composer-select'); s.value = 'sonnet'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(250);
    const modelPicked = await evaluate('__host.state().options.model');
    at = await centreOf('.session-view .composer-toggle[data-kind="files"]');
    if (at) await click(at.x, at.y);
    await sleep(700);
    const filesAttached = await evaluate(composerState);
    at = await centreOf('.session-view .composer-toggle[data-kind="skills"]');
    if (at) await click(at.x, at.y);
    await sleep(1600);
    const skillsPanel = await evaluate(
      `({ mode: __orbit.constellation().mode, overView: ((c) => !!c && !c.hidden && c.parentElement?.classList.contains('sv-overlay') === true)(document.querySelector('.constellation')), pressed: document.querySelector('.session-view .composer-toggle[data-kind="skills"]').getAttribute('aria-pressed'), shown: document.querySelectorAll('.skill-node[data-shown="true"]').length })`,
    );
    const node = await evaluate(`(() => { const n = document.querySelector('.skill-node[data-shown="true"]'); if (!n) return null; const r = n.getBoundingClientRect(); return { skill: n.dataset.skill, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (node) {
      await mouse('mouseMoved', node.x, node.y);
      await sleep(200);
      await click(node.x, node.y);
      await sleep(400);
    }
    await screenshot('4h-view-composer.png');
    const skillAttached = await evaluate(composerState);
    await key('Escape', 'Escape', 27);
    await sleep(500);
    const escape = await evaluate(`({ constellationClosed: !__orbit.constellation().mode, viewOpen: !document.querySelector('.session-view').hidden })`);
    const turnEnded = await waitFor(evaluate, `__host.sessions().states.find((s) => s.key === ${JSON.stringify(viewKey)})?.phase === 'idle'`, 12_000);
    await sleep(400);
    const idle = await evaluate(composerState);
    await evaluate(`document.querySelector('.session-view .composer-input').focus()`);
    await key('Enter', 'Enter', 13);
    await sleep(900);
    const sent = await evaluate('__host.skillPrompts.at(-1)');
    const afterSend = await evaluate(composerState);
    const transcript = await evaluate(`(() => { const p = [...document.querySelectorAll('.session-view .transcript .t-prompt')].at(-1); return { text: p?.textContent, skills: p?.querySelectorAll('.t-skill').length ?? 0, files: p?.querySelectorAll('.t-attached').length ?? 0 }; })()`);
    await screenshot('4i-view-composer-sent.png');
    viewComposer = { working, afterEnter, modelPicked, filesAttached, skillsPanel, skill: node?.skill, skillAttached, escape, turnEnded, idle, sent, afterSend, transcript };
    viewComposer.ok =
      working.open && working.phase === 'working' && working.inputEnabled && working.focused && working.modelEnabled && working.action === 'Stop' &&
      afterEnter.phase === 'working' && afterEnter.input === viewReply &&
      modelPicked === 'sonnet' &&
      filesAttached.phase === 'working' && filesAttached.files.length === 2 &&
      skillsPanel.mode === 'skills' && skillsPanel.overView && skillsPanel.pressed === 'true' &&
      node !== null && skillAttached.skills.includes(node.skill) &&
      escape.constellationClosed && escape.viewOpen &&
      turnEnded && idle.action === 'Send' && idle.input === viewReply &&
      sent?.text === viewReply && sent.key === viewKey && sent.skills.includes(node.skill) && sent.files.length === 2 &&
      afterSend.input === '' && afterSend.skills.length === 0 && afterSend.files.length === 0 &&
      transcript.skills === 1 && transcript.files === 2;
    await evaluate(`(() => { const s = document.querySelector('.session-view .composer-select'); s.value = ''; s.dispatchEvent(new Event('change')); })()`);
    await key('Escape', 'Escape', 27);
    await sleep(500);
    await waitFor(evaluate, `__host.sessions().states.every((s) => s.phase === 'idle')`, 12_000);
    await sleep(300);
  }
  report.checks.viewComposer = viewComposer;

  // History: the History toggle opens a gyroscope per earlier conversation; clicking one opens the history panel out of it,
  // and Continue asks the host to resume it and opens the drawer for the next prompt.
  at = await tabAt();
  await click(at.x, at.y);
  await sleep(600);
  at = await centreOf('.composer-toggle[data-kind="history"]');
  await click(at.x, at.y);
  await sleep(2600);
  // Every conversation shown sits inside the field, however wide the timeline.
  const inField = `(() => { const f = document.querySelector('.constellation-field').getBoundingClientRect(); return [...document.querySelectorAll('.history-node[data-shown="true"]')].every((n) => { const r = n.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2; return x >= f.left && x <= f.right && y >= f.top && y <= f.bottom; }); })()`;
  const historyOpen = await evaluate(`({ ...__orbit.constellation(), nodes: document.querySelectorAll('.history-node').length, inField: ${inField} })`);
  await screenshot('6d-history.png');
  // The time range under the timeline: the older thumb dragged to the middle of the track keeps only the conversations
  // last active since, which spread out over the field again; All brings every one back.
  let historyRange = null;
  const thumbFrom = await centreOf('.tr-thumb[data-edge="from"]');
  const railMiddle = await centreOf('.tr-rail');
  if (thumbFrom && railMiddle) {
    await mouse('mouseMoved', thumbFrom.x, thumbFrom.y);
    await mouse('mousePressed', thumbFrom.x, thumbFrom.y);
    for (let k = 1; k <= 8; k++) {
      await mouse('mouseMoved', thumbFrom.x + ((railMiddle.x - thumbFrom.x) * k) / 8, thumbFrom.y);
      await sleep(30);
    }
    await mouse('mouseReleased', railMiddle.x, thumbFrom.y);
    await sleep(1600);
    historyRange = await evaluate(
      `({ range: __orbit.constellation().range, glyphs: __orbit.constellation().glyphs, ticks: document.querySelectorAll('.tr-tick').length, ticksIn: document.querySelectorAll('.tr-tick[data-in="true"]').length, sub: document.querySelector('.constellation-sub').textContent, inField: ${inField} })`,
    );
    await screenshot('6l-history-range.png');
    const all = await centreOf('.tr-all');
    if (all) await click(all.x, all.y);
    await sleep(1200);
    historyRange.restored = await evaluate(`__orbit.constellation().range === undefined && __orbit.constellation().glyphs === ${historyOpen.glyphs}`);
    historyRange.ok = historyRange.range !== undefined && historyRange.glyphs > 0 && historyRange.glyphs < historyOpen.glyphs && historyRange.glyphs === historyRange.ticksIn && historyRange.inField && historyRange.restored;
  }
  const conversation = await evaluate(`(() => { const node = document.querySelector('.history-node[data-shown="true"]'); if (!node) return null; const r = node.getBoundingClientRect(); return { id: node.dataset.conversation, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  let historyPanel = null;
  if (conversation) {
    await mouse('mouseMoved', conversation.x, conversation.y);
    await sleep(250);
    await click(conversation.x, conversation.y);
    await sleep(800);
    historyPanel = await evaluate(`({ open: !document.querySelector('.history-panel').hidden, title: document.querySelector('.hp-title').textContent, files: document.querySelectorAll('.hp-file').length, drawerClosed: document.querySelector('.drawer').dataset.open !== 'true', constellationClosed: !__orbit.constellation().mode })`);
    await screenshot('6e-history-panel.png');
    at = await centreOf('.hp-resume');
    await click(at.x, at.y);
    await sleep(700);
    historyPanel.resumed = (await evaluate('__host.resumed')).includes(conversation.id);
    historyPanel.closedOnResume = await evaluate(`document.querySelector('.history-panel').hidden`);
    historyPanel.drawerOpened = await evaluate(`document.querySelector('.drawer').dataset.open === 'true'`);
    await key('Escape', 'Escape', 27);
    await sleep(500);
  }
  report.checks.history = { open: historyOpen, range: historyRange, panel: historyPanel };

  // MCP: a call to an MCP server's tool brings its station out beside Claude's star, joined by a beam; after the answer it leaves.
  await evaluate('__host.mcp(700)');
  await sleep(1000);
  const stationsOut = await evaluate('__orbit.world().mcpStations');
  await screenshot('6f-mcp.png');
  report.checks.mcp = { stationsOut, labels: await evaluate(`[...document.querySelectorAll('.label-mcp')].filter((label) => !label.hidden).map((label) => label.textContent)`), leftAfterward: await waitFor(evaluate, '__orbit.world().mcpStations === 0', 8_000) };

  // MCP view: the sheet's MCP button opens a constellation of the MCP servers, a 16-cell each, coloured by how it
  // connected; a click on one that needs sign-in offers Sign in, which reaches the host and connects it; Reload asks every
  // server again, and Esc closes the view.
  const drawerOpen = `document.querySelector('.drawer').dataset.open === 'true'`;
  if (!(await evaluate(drawerOpen))) {
    at = await tabAt();
    await click(at.x, at.y);
    await sleep(700);
  }
  let mcpView = { opened: false };
  at = await centreOf('.composer-toggle[data-kind="mcp"]');
  if (at) {
    await click(at.x, at.y);
    await sleep(2400);
    const mcpOpen = await evaluate(
      `({ ...__orbit.constellation(), nodes: document.querySelectorAll('.mcp-node').length, shown: document.querySelectorAll('.mcp-node[data-shown="true"]').length, servers: __host.mcpServers().length, pressed: document.querySelector('.composer-toggle[data-kind="mcp"]').getAttribute('aria-pressed'), state: document.querySelector('.sheet-mcp').dataset.state, keys: [...document.querySelectorAll('.constellation-key')].map((k) => k.textContent), refresh: document.querySelector('.constellation-refresh').textContent })`,
    );
    await screenshot('6m-mcp-view.png');
    mcpView = { opened: mcpOpen.mode === 'mcp' && mcpOpen.nodes === mcpOpen.servers && mcpOpen.pressed === 'true', open: mcpOpen };
    const github = await centreOf('.mcp-node[data-server="github"][data-shown="true"]');
    if (github) {
      await click(github.x, github.y);
      await sleep(400);
      const offered = await evaluate(`({ pinned: __orbit.constellation().pinned, actions: [...document.querySelectorAll('.cd-action')].map((b) => b.dataset.action), title: document.querySelector('.cd-title').textContent })`);
      const signIn = await centreOf('.cd-action[data-action="signIn"]');
      if (signIn) await click(signIn.x, signIn.y);
      const pendingShown = await waitFor(evaluate, `document.querySelector('.cd-action[data-action="signIn"]')?.disabled === true`, 2000);
      const connected = await waitFor(evaluate, `__host.mcpServers().find((s) => s.name === 'github')?.status === 'connected'`, 4000);
      await sleep(1200);
      mcpView.signIn = {
        offered,
        pendingShown,
        reachedHost: await evaluate(`__host.mcpActions.some((a) => a.server === 'github' && a.action === 'signIn')`),
        connected,
        afterward: await evaluate(`({ actions: [...document.querySelectorAll('.cd-action')].map((b) => b.dataset.action), text: document.querySelector('.cd-text').textContent, status: document.querySelector('.mcp-node[data-server="github"]')?.dataset.status })`),
      };
      await screenshot('6n-mcp-signed-in.png');
    }
    at = await centreOf('.constellation-refresh');
    await click(at.x, at.y);
    const disabledWhileLoading = await waitFor(evaluate, `document.querySelector('.constellation-refresh').disabled`, 1500);
    const settled = await waitFor(evaluate, `!document.querySelector('.constellation-refresh').disabled && __host.mcpServers().every((s) => s.status !== 'pending')`, 4000);
    mcpView.reload = { reachedHost: (await evaluate('__host.mcpReloads()')) === 1, disabledWhileLoading, settled, drawerCount: await evaluate(`document.querySelector('.sheet-mcp-count').textContent`) };
    await key('Escape', 'Escape', 27);
    await sleep(500);
    mcpView.closedByEscape = await evaluate('!__orbit.constellation().mode');
    if (await evaluate(drawerOpen)) {
      await key('Escape', 'Escape', 27);
      await sleep(500);
    }
  }
  report.checks.mcpView = mcpView;

  // Hidden panel: the rAF loop must stop entirely.
  await evaluate('__host.setVisible(false)');
  await sleep(400);
  const hiddenA = await evaluate('__orbit.debug.frames');
  await sleep(1500);
  const hiddenB = await evaluate('__orbit.debug.frames');
  await evaluate('__host.setVisible(true)');
  await sleep(800);
  const shown = await evaluate('__orbit.debug.frames');
  report.checks.hiddenStopsLoop = { framesWhileHidden: hiddenB - hiddenA, resumedFrames: shown - hiddenB };

  // Idle session with nothing animating: the loop parks.
  await evaluate('__host.pause()');
  await mouse('mouseMoved', 2, 2);
  await sleep(4500);
  const idleA = await evaluate('__orbit.debug.frames');
  await sleep(1500);
  const idleB = await evaluate('__orbit.debug.frames');
  report.checks.idleParks = { framesWhileIdle: idleB - idleA, perfText: await evaluate(`document.querySelector('.perf').textContent`) };
  await screenshot('5-idle.png');

  report.hostMessages = await evaluate('[...new Set(__host.received)]');
  report.hostLogs = await evaluate('__host.logs');
  report.checks.consoleClean = report.console.length === 0;
  cdp.close();
} finally {
  chrome.process.kill();
  server.close();
}

writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

function indexThisRepository() {
  const target = join(root, '.harness', 'graph.json');
  mkdirSync(dirname(target), { recursive: true });
  if (!skipBuild) runNode(join(packages, 'indexer', 'build.mjs'));
  runNode(join(packages, 'indexer', 'dist', 'indexer.mjs'), root, '--out', target);
  return target;
}

/** The webview and the simulated host, unless they were built already (--skip-build). */
function build() {
  if (skipBuild) return;
  runNode(join(packages, 'webview', 'build.mjs'));
  runNode(join(here, 'build.mjs'));
}

function runNode(...args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function page() {
  const config = { graph: JSON.parse(readFileSync(graphPath, 'utf8')) };
  const csp = `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; worker-src blob:`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Orbit harness</title>
</head>
<body>
<script type="application/json" id="harness-config">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>
<script nonce="${nonce}" src="/host-sim.js"></script>
<script nonce="${nonce}" src="/webview.js"></script>
</body>
</html>`;
}

/** Serves the page and its two scripts, each from where its build writes it, and nothing else. */
function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };
  const files = {
    '/.harness/index.html': join(root, '.harness', 'index.html'),
    '/host-sim.js': join(here, 'dist', 'host-sim.js'),
    '/webview.js': join(packages, 'webview', 'dist', 'webview.js'),
    '/webview.js.map': join(packages, 'webview', 'dist', 'webview.js.map'),
  };
  const server = createServer((request, response) => {
    const file = files[normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname))];
    if (!file || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launchChrome() {
  const profile = join(root, '.harness', 'chrome-profile');
  rmSync(profile, { recursive: true, force: true });
  const child = spawn(
    chromePath,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`, '--enable-unsafe-swiftshader', 'about:blank'],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  return { process: child, port };
}

async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  };
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    on: (listener) => listeners.push(listener),
    close: () => socket.close(),
  };
}

async function waitFor(evaluate, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}
