import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROVIDER_MENU_MODELS,
  buildDetectedMappings,
  detectedModels,
  pickDetectedModel,
  shouldWriteContextWindow,
} from "../src/providerAutoSetup.ts";

const listed = (...entries) => entries.map(([id, contextWindow]) => ({
  id,
  created: null,
  contextWindow: contextWindow ?? null,
}));

test("the model the user already chose survives a fetch that offers it", () => {
  const models = listed(["gpt-5.6-sol", 200000], ["gpt-5.5", 128000]);
  assert.deepEqual(pickDetectedModel(models, "gpt-5.5"), { id: "gpt-5.5", contextWindow: 128000 });
  assert.deepEqual(pickDetectedModel(models, "   "), { id: "gpt-5.6-sol", contextWindow: 200000 });
  assert.deepEqual(pickDetectedModel(models, "not-offered-anywhere"), { id: "gpt-5.6-sol", contextWindow: 200000 });
});

test("blank and duplicate upstream entries never reach the form", () => {
  const models = [
    { id: "   ", contextWindow: 1 },
    { id: "gpt-5.5", contextWindow: 128000 },
    { id: " gpt-5.5 ", contextWindow: 999 },
  ];
  assert.deepEqual(detectedModels(models), [{ id: "gpt-5.5", contextWindow: 128000 }]);
  assert.equal(pickDetectedModel([{ id: "", contextWindow: 5 }], ""), null);
});

test("an empty mapping list becomes the whole upstream menu with its windows", () => {
  const models = detectedModels(listed(["gpt-5.6-sol", 200000], ["gpt-5.5", null]));
  assert.deepEqual(buildDetectedMappings(models, []), [
    { model: "gpt-5.6-sol", displayName: "gpt-5.6-sol", contextWindow: 200000, compactPercent: null },
    { model: "gpt-5.5", displayName: "gpt-5.5", contextWindow: null, compactPercent: null },
  ]);
});

test("a menu longer than Codex's ceiling is cut at the ceiling up front", () => {
  const models = detectedModels(listed(
    ...Array.from({ length: MAX_PROVIDER_MENU_MODELS + 12 }, (_, index) => [`model-${index}`, 1000]),
  ));
  const mappings = buildDetectedMappings(models, []);
  assert.equal(mappings.length, MAX_PROVIDER_MENU_MODELS);
  assert.equal(mappings.at(-1).model, `model-${MAX_PROVIDER_MENU_MODELS - 1}`);
});

test("a re-fetch keeps every hand made row and appends only what the list lacks", () => {
  const models = detectedModels(listed(["gpt-5.6-sol", 200000], ["gpt-5.5", 128000], ["gpt-5.4", 64000]));
  const existing = [
    { model: "gpt-5.4", displayName: "Small one", contextWindow: 64000, compactPercent: 90 },
    { model: "gpt-5.5", displayName: "Mid one", contextWindow: null, compactPercent: null },
  ];
  const next = buildDetectedMappings(models, existing);
  assert.deepEqual(next, [
    { model: "gpt-5.4", displayName: "Small one", contextWindow: 64000, compactPercent: 90 },
    { model: "gpt-5.5", displayName: "Mid one", contextWindow: 128000, compactPercent: null },
    { model: "gpt-5.6-sol", displayName: "gpt-5.6-sol", contextWindow: 200000, compactPercent: null },
  ]);
  assert.notEqual(next[0], existing[0], "the rows must be copied, never mutated in place");
});

test("a model the provider stopped listing stays in the menu instead of vanishing", () => {
  const models = detectedModels(listed(["gpt-5.5", 128000]));
  const existing = [
    { model: "gpt-5.5", displayName: "Mid one", contextWindow: 128000, compactPercent: null },
    { model: "retired-model", displayName: "Kept by hand", contextWindow: 32000, compactPercent: 80 },
  ];
  assert.deepEqual(buildDetectedMappings(models, existing), existing);
});

test("the ceiling counts the rows already in the menu, so an append cannot overflow it", () => {
  const existing = Array.from({ length: MAX_PROVIDER_MENU_MODELS - 1 }, (_, index) => ({
    model: `kept-${index}`,
    displayName: `Kept ${index}`,
    contextWindow: null,
    compactPercent: null,
  }));
  const models = detectedModels(listed(["brand-new", 128000], ["another-one", 64000]));
  const next = buildDetectedMappings(models, existing);
  assert.equal(next.length, MAX_PROVIDER_MENU_MODELS);
  assert.equal(next.at(-1).model, "brand-new");
});

test("an upstream window only ever widens what the draft already declares", () => {
  assert.equal(shouldWriteContextWindow(null, 200000), true);
  assert.equal(shouldWriteContextWindow(128000, 200000), true);
  assert.equal(shouldWriteContextWindow(1000000, 200000), false);
  assert.equal(shouldWriteContextWindow(200000, 200000), false);
  assert.equal(shouldWriteContextWindow(1000000, null), false);
  assert.equal(shouldWriteContextWindow(null, null), false);
});
