import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublishedComparison } from "../ralph-viz/server.js";

function responseHeaders(values = {}) {
  const normalized = new Map(
    Object.entries(values).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    get(name) {
      return normalized.get(String(name).toLowerCase()) ?? null;
    },
  };
}

test("published comparison refresh uses the GCS ETag and reuses data on 304", async () => {
  const payload = { generatedAt: "2026-08-09T00:00:00.000Z", runs: [] };
  let initialRequest;
  const initial = await fetchPublishedComparison("https://storage.example/comparison.json", null, {
    now: () => 1000,
    fetchImpl: async (url, options) => {
      initialRequest = { url, options };
      return {
        ok: true,
        status: 200,
        headers: responseHeaders({
          etag: '"generation-one"',
          "last-modified": "Sun, 09 Aug 2026 00:00:00 GMT",
        }),
        json: async () => payload,
      };
    },
  });

  assert.equal(initialRequest.url, "https://storage.example/comparison.json");
  assert.deepEqual(initialRequest.options.headers, {});
  assert.equal(initialRequest.options.cache, "no-store");
  assert.equal(initial.etag, '"generation-one"');
  assert.equal(initial.lastModified, "Sun, 09 Aug 2026 00:00:00 GMT");
  assert.strictEqual(initial.value, payload);

  let refreshRequest;
  const refreshed = await fetchPublishedComparison(
    "https://storage.example/comparison.json",
    initial,
    {
      now: () => 2000,
      fetchImpl: async (url, options) => {
        refreshRequest = { url, options };
        return {
          ok: false,
          status: 304,
          headers: responseHeaders(),
          json: async () => {
            throw new Error("304 response body should not be read");
          },
        };
      },
    },
  );

  assert.deepEqual(refreshRequest.options.headers, {
    "If-None-Match": '"generation-one"',
  });
  assert.strictEqual(refreshed.value, payload);
  assert.equal(refreshed.loadedAt, 2000);
  assert.equal(refreshed.etag, '"generation-one"');
});

test("published comparison refresh falls back to Last-Modified", async () => {
  const cached = {
    loadedAt: 1000,
    value: { runs: [] },
    etag: null,
    lastModified: "Sun, 09 Aug 2026 00:00:00 GMT",
  };
  let requestHeaders;

  const refreshed = await fetchPublishedComparison(
    "https://storage.example/comparison.json",
    cached,
    {
      now: () => 2000,
      fetchImpl: async (_url, options) => {
        requestHeaders = options.headers;
        return {
          ok: false,
          status: 304,
          headers: responseHeaders(),
          json: async () => {
            throw new Error("304 response body should not be read");
          },
        };
      },
    },
  );

  assert.deepEqual(requestHeaders, {
    "If-Modified-Since": "Sun, 09 Aug 2026 00:00:00 GMT",
  });
  assert.strictEqual(refreshed.value, cached.value);
  assert.equal(refreshed.loadedAt, 2000);
});
