export const VIEWER_ASSETS = Object.freeze([
  { name: "index.html", pathname: "/", contentType: "text/html; charset=utf-8" },
  { name: "app.js", pathname: "/app.js", contentType: "application/javascript; charset=utf-8" },
  { name: "assignment-layouts.js", pathname: "/assignment-layouts.js", contentType: "application/javascript; charset=utf-8" },
  { name: "command-status.js", pathname: "/command-status.js", contentType: "application/javascript; charset=utf-8" },
  { name: "entry-dedupe.js", pathname: "/entry-dedupe.js", contentType: "application/javascript; charset=utf-8" },
  { name: "model-pricing.js", pathname: "/model-pricing.js", contentType: "application/javascript; charset=utf-8" },
  { name: "safe-markdown.js", pathname: "/safe-markdown.js", contentType: "application/javascript; charset=utf-8" },
  { name: "test-progress-evidence.js", pathname: "/test-progress-evidence.js", contentType: "application/javascript; charset=utf-8" },
  { name: "test-status-summary.js", pathname: "/test-status-summary.js", contentType: "application/javascript; charset=utf-8" },
  { name: "styles.css", pathname: "/styles.css", contentType: "text/css; charset=utf-8" },
]);

export const VIEWER_ASSET_NAMES = Object.freeze(VIEWER_ASSETS.map((asset) => asset.name));

export function viewerAssetForPathname(pathname) {
  return VIEWER_ASSETS.find((asset) => asset.pathname === pathname) ?? null;
}
