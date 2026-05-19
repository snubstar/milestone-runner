import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("static dashboard frontend has valid script syntax and DOM wiring", async () => {
  const publicRoot = path.join(process.cwd(), "dashboard", "public");
  const html = await readFile(path.join(publicRoot, "index.html"), "utf8");
  const appJs = await readFile(path.join(publicRoot, "app.js"), "utf8");

  assert.doesNotThrow(() => {
    new Function(appJs);
  });

  const htmlIds = new Set(
    [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
  );
  const queriedIds = [
    ...appJs.matchAll(/document\.querySelector\("#([^"]+)"\)/g),
  ].map((match) => match[1]);

  assert.notEqual(queriedIds.length, 0);
  for (const id of queriedIds) {
    assert.equal(htmlIds.has(id), true, `Missing static dashboard element #${id}`);
  }
});

test("static dashboard referenced assets exist", async () => {
  const publicRoot = path.join(process.cwd(), "dashboard", "public");
  const html = await readFile(path.join(publicRoot, "index.html"), "utf8");
  const assetPaths = [...html.matchAll(/\b(?:href|src)="\/([^"]+)"/g)].map(
    (match) => match[1],
  );

  assert.notEqual(assetPaths.length, 0);
  for (const assetPath of assetPaths) {
    const asset = await stat(path.join(publicRoot, assetPath));
    assert.equal(asset.isFile(), true, `Missing static dashboard asset ${assetPath}`);
  }
});
