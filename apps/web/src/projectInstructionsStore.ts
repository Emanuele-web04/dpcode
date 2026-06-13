// FILE: projectInstructionsStore.ts
// Purpose: Persist project-level instructions (freeform context, architecture notes,
//          repo links, etc.) that auto-inherit into new thread notes.
// Layer: Web UI state store
// Exports: Project instructions hook, selectors

import { type ProjectId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const PROJECT_INSTRUCTIONS_STORAGE_KEY = "synara:project-instructions:v1";

interface ProjectInstructionsStore {
  /** Per-project instructions keyed by project id. */
  instructionsByProjectId: Record<string, string>;
  /** Set (or replace) instructions for a project. */
  setInstructions: (projectId: ProjectId, instructions: string) => void;
  /** Clear instructions for a project. */
  clearInstructions: (projectId: ProjectId) => void;
}

export const useProjectInstructionsStore = create<ProjectInstructionsStore>()(
  persist(
    (set) => ({
      instructionsByProjectId: {},
      setInstructions: (projectId, instructions) =>
        set((state) => ({
          instructionsByProjectId: {
            ...state.instructionsByProjectId,
            [projectId]: instructions,
          },
        })),
      clearInstructions: (projectId) =>
        set((state) => {
          const next = { ...state.instructionsByProjectId };
          delete next[projectId];
          return { instructionsByProjectId: next };
        }),
    }),
    {
      name: PROJECT_INSTRUCTIONS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/**
 * Stable selector: returns the project instructions string (or empty string).
 * Keeps a reference-stable return so consuming components only re-render when
 * the instructions for that specific project actually change.
 */
export function selectProjectInstructions(
  projectId: ProjectId | null | undefined,
): (store: ProjectInstructionsStore) => string {
  let previousProjectId: ProjectId | null | undefined;
  let previousInstructions = "";

  return (store) => {
    if (projectId === previousProjectId) {
      return previousInstructions;
    }
    previousProjectId = projectId;
    previousInstructions = projectId
      ? (store.instructionsByProjectId[projectId] ?? "")
      : "";
    return previousInstructions;
  };
}
