import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPublishedCatalogPreserved,
  publishExcludePattern,
} from "../scripts/publish-viz-static.js";

test("publish guard accepts catalogs that retain old runs and add a new run", () => {
  assert.doesNotThrow(() => assertPublishedCatalogPreserved(
    { runs: [{ id: "old/run" }, { id: "new/run" }] },
    { runs: [{ id: "old/run" }] },
    {
      runs: [{ spec: "old" }, { spec: "new" }],
      rows: [{ pa: "pa1", runs: [{ cost: 1 }, { cost: 2 }] }],
    },
    {
      runs: [{ spec: "old" }],
      rows: [{ pa: "pa1", runs: [{ cost: 1 }] }],
    },
  ));
});

test("publish guard rejects a dropped run artifact", () => {
  assert.throws(() => assertPublishedCatalogPreserved(
    { runs: [{ id: "new/run" }] },
    { runs: [{ id: "old/run" }] },
    { runs: [{ spec: "old" }] },
    { runs: [{ spec: "old" }] },
  ), /drops published runs: old\/run/);
});

test("publish guard rejects a dropped comparison column", () => {
  assert.throws(() => assertPublishedCatalogPreserved(
    { runs: [{ id: "old/run" }] },
    { runs: [{ id: "old/run" }] },
    { runs: [{ spec: "new" }] },
    { runs: [{ label: "1-old" }] },
  ), /comparison drops published runs: old/);
});

test("publish sync excludes catalogs and every retained run directory", () => {
  const pattern = new RegExp(publishExcludePattern({
    runs: [
      { safeId: "trusted-old", exportRetained: true },
      { safeId: "live", exportRetained: false },
    ],
  }));
  assert.equal(pattern.test("data/runs.json"), true);
  assert.equal(pattern.test("data/comparisons/pa-costs.json"), true);
  assert.equal(pattern.test("data/runs/trusted-old/turns/turn-0001.json"), true);
  assert.equal(pattern.test("data/runs/live/turns/turn-0001.json"), false);
});

test("publish guard rejects dropped PA rows and archived cells", () => {
  const manifests = [
    { runs: [{ id: "old/run" }] },
    { runs: [{ id: "old/run" }] },
  ];
  const published = {
    runs: [{ spec: "old" }],
    rows: [{ pa: "pa1", runs: [{ cost: 1 }] }],
  };
  assert.throws(() => assertPublishedCatalogPreserved(
    ...manifests,
    { runs: [{ spec: "old" }], rows: [] },
    published,
  ), /drops published row pa1/);
  assert.throws(() => assertPublishedCatalogPreserved(
    ...manifests,
    { runs: [{ spec: "old" }], rows: [{ pa: "pa1", runs: [null] }] },
    published,
  ), /drops old data at pa1/);
});
