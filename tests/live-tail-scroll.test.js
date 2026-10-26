import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const app = readFileSync(new URL("../ralph-viz/app.js", import.meta.url), "utf8");

function viewer() {
  let now = 10000;
  const frames = [];
  const timers = [];
  const root = {
    scrollHeight: 3000, clientHeight: 600, scrollWidth: 400, clientWidth: 400,
    scrollTop: 2400, scrollLeft: 0,
    scrollTo({ top }) { this.scrollTop = top; },
  };
  const state = {
    followLiveTail: true, liveTailDetached: false, lastTouchY: null,
    userScrollVersion: 0, lastUserScrollAt: 0, lastProgrammaticScrollAt: 0,
    lastObservedScrollTop: root.scrollTop, progressDockSpacePx: 220,
    mobileScrollPauseUntil: 0, scrollDebugEnabled: false,
  };
  const context = vm.createContext({
    state, BOTTOM_STICKY_PX: 32, PROGRESS_DOCK_EXTRA_SPACE_PX: 12,
    MOBILE_SCROLL_REFRESH_PAUSE_MS: 5000,
    performance: { now: () => now },
    navigator: { maxTouchPoints: 5 },
    document: { scrollingElement: root, documentElement: { style: { setProperty() {} } } },
    window: {
      matchMedia: () => ({ matches: true }),
      setTimeout: (callback) => timers.push(callback),
    },
    progressDock: { getBoundingClientRect: () => ({ height: 208 }) },
    afterNextPaint: (callback) => frames.push(callback),
    scrollDebug() {},
    resetPageHorizontalScroll() {},
    captureScrollAnchors: () => [],
    restoreScrollAnchor: () => false,
  });
  for (const name of [
    "scrollingRoot", "getScrollMetrics", "bottomStickyThresholdPx", "bottomReservePx",
    "shouldFollowLiveTail", "captureScrollSnapshot", "resolveScrollSnapshot",
    "restoreScrollAfterRender", "applyScrollRestoration", "scrollToBottomNow", "setScrollTop",
    "markUserScrollIntent", "handleTouchScrollIntent", "handleObservedScroll",
    "isMobileScrollViewport", "markMobileScrollPause", "updateProgressDockSpace",
  ]) {
    const source = app.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, "m"));
    assert.ok(source, name);
    vm.runInContext(source[0], context);
  }
  return {
    context, state, root,
    tick(ms = 20) { now += ms; },
    drain() {
      while (frames.length || timers.length) (frames.shift() ?? timers.shift())();
    },
    touch(type, y) { context.handleTouchScrollIntent({ type, touches: [{ clientY: y }] }); },
  };
}

test("an upward phone swipe releases follow before leaving the footer's sticky region", () => {
  const v = viewer();
  v.touch("touchstart", 200);
  v.tick();
  v.touch("touchmove", 220);
  v.root.scrollTop -= 20;
  v.context.handleObservedScroll();
  assert.equal(v.state.followLiveTail, false);
  assert.equal(v.context.shouldFollowLiveTail(), false);
  assert.equal(v.context.captureScrollSnapshot().stickToBottom, false);
  // A refresh or viewport resize after the gesture must not reattach it.
  v.tick(6000);
  v.context.updateProgressDockSpace();
  v.drain();
  assert.equal(v.root.scrollTop, 2380);
  assert.equal(v.context.shouldFollowLiveTail(), false);
});

test("queued footer layout and render retries cannot undo a swipe", () => {
  const v = viewer();
  const snapshot = v.context.captureScrollSnapshot();
  v.context.updateProgressDockSpace();
  v.context.restoreScrollAfterRender(snapshot, { immediate: true });
  v.tick();
  v.touch("touchstart", 200);
  v.tick();
  v.touch("touchmove", 230);
  v.root.scrollTop -= 30;
  v.context.handleObservedScroll();
  v.drain();
  assert.equal(v.root.scrollTop, 2370);
  assert.equal(v.context.shouldFollowLiveTail(), false);
});

test("inertial scrolling invalidates restoration captured after the last touchmove", () => {
  const v = viewer();
  v.touch("touchstart", 200);
  v.tick();
  v.touch("touchmove", 220);
  v.root.scrollTop -= 20;
  v.context.handleObservedScroll();
  const snapshot = v.context.captureScrollSnapshot();
  v.context.restoreScrollAfterRender(snapshot);
  v.tick(350);
  v.root.scrollTop -= 100;
  v.context.handleObservedScroll();
  v.drain();
  assert.equal(v.root.scrollTop, 2280);
});

test("live follow resumes when the reader scrolls down to the actual bottom", () => {
  const v = viewer();
  v.context.markUserScrollIntent("wheel", -100);
  v.root.scrollTop = 2200;
  v.context.handleObservedScroll();
  v.tick();
  v.context.markUserScrollIntent("wheel", 100);
  v.root.scrollTop = 2300;
  v.context.handleObservedScroll();
  assert.equal(v.context.shouldFollowLiveTail(), false);
  v.tick();
  v.context.markUserScrollIntent("wheel", 100);
  v.root.scrollTop = 2400;
  v.context.handleObservedScroll();
  assert.equal(v.context.shouldFollowLiveTail(), true);
  v.root.scrollHeight += 100;
  v.context.restoreScrollAfterRender(v.context.captureScrollSnapshot());
  v.drain();
  assert.equal(v.root.scrollTop, 2500);
});

test("footer resizing still follows new live output without a reader gesture", () => {
  const v = viewer();
  v.context.updateProgressDockSpace();
  v.root.scrollHeight += 60;
  v.drain();
  assert.equal(v.root.scrollTop, 2460);
  assert.equal(v.state.followLiveTail, true);
});

test("a touch starting after footer resize cancels its queued jump before any movement", () => {
  const v = viewer();
  v.context.updateProgressDockSpace();
  v.root.scrollHeight += 60;
  v.touch("touchstart", 200);
  v.drain();
  assert.equal(v.state.liveTailDetached, false);
  assert.equal(v.root.scrollTop, 2400);
});
