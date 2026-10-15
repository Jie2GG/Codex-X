import type { ProviderModel, ProviderModelMapping } from "./types";

// Codex's model menu caps at 64 entries and the current default model always
// reserves one of them, so an auto-imported list stops at that ceiling.
export const MAX_PROVIDER_MENU_MODELS = 64;

export type DetectedModel = {
  id: string;
  contextWindow: number | null;
};

// The upstream list is the authority on what a custom provider can actually
// serve, so duplicates collapse and blank ids drop out before anything else.
export function detectedModels(models: readonly ProviderModel[]): DetectedModel[] {
  const usable: DetectedModel[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    usable.push({ id, contextWindow: model.contextWindow ?? null });
  }
  return usable;
}

// Keep the model the user already picked whenever the upstream really serves it,
// and otherwise fall back to the newest entry the provider listed.
export function pickDetectedModel(
  models: readonly ProviderModel[],
  currentModel: string,
): DetectedModel | null {
  const usable = detectedModels(models);
  const chosen = usable.find((model) => model.id === currentModel.trim()) ?? usable[0];
  return chosen ?? null;
}

// Every fetch folds the whole upstream list into the menu, because the models a
// provider serves are exactly what the user should be able to switch to. Rows
// already arranged keep their place, their display names and the windows that
// were typed in; only the models still missing get appended, capped where Codex
// caps the menu. A model the provider stopped listing stays rather than vanishing.
export function buildDetectedMappings(
  models: readonly DetectedModel[],
  existing: readonly ProviderModelMapping[],
): ProviderModelMapping[] {
  const mappings = existing.map((row) => ({ ...row }));
  const listed = new Set(mappings.map((row) => row.model.trim()).filter(Boolean));
  for (const row of mappings) {
    if (row.contextWindow !== null) continue;
    const match = models.find((model) => model.id === row.model.trim());
    if (match) row.contextWindow = match.contextWindow;
  }
  for (const model of models) {
    if (listed.has(model.id)) continue;
    if (mappings.length >= MAX_PROVIDER_MENU_MODELS) break;
    listed.add(model.id);
    mappings.push({
      model: model.id,
      displayName: model.id,
      contextWindow: model.contextWindow,
      compactPercent: null,
    });
  }
  return mappings;
}

// The 1M preset is a deliberate choice, so an upstream number only ever widens a
// missing or smaller window and never shrinks what was set by hand.
export function shouldWriteContextWindow(
  existing: number | null,
  detected: number | null,
): boolean {
  if (detected === null) return false;
  return existing === null || existing < detected;
}
