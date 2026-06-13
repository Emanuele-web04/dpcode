// FILE: EnvironmentProjectInstructionsSection.tsx
// Purpose: "Instructions" section of the Environment panel — a per-project freeform
//          scratchpad for architecture notes, repo links, and other context that
//          auto-inherits into new thread notes.
// Layer: Environment panel section

import { useCallback, useEffect, useRef, useState } from "react";
import { THREAD_NOTES_MAX_CHARS, type ProjectId } from "@t3tools/contracts";

import { Textarea } from "~/components/ui/textarea";
import { useProjectInstructionsStore, selectProjectInstructions } from "~/projectInstructionsStore";
import { Button } from "~/components/ui/button";

import { EnvironmentCollapsibleSection } from "./EnvironmentRow";
import { toastManager } from "~/components/ui/toast";

function useProjectInstructionsAutosave(projectId: ProjectId | null) {
  const instructions = useProjectInstructionsStore(
    // eslint-disable-next-line react-hooks/rules-of-hooks
    // biome-ignore lint: selectProjectInstructions is a stable selector factory
    projectId ? selectProjectInstructions(projectId) : () => "",
  );
  const setInstructions = useProjectInstructionsStore((s) => s.setInstructions);
  const [value, setValue] = useState(instructions);
  const lastCommittedRef = useRef(instructions);
  const [pending, setPending] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync when the server value changes externally (e.g. from another tab).
  useEffect(() => {
    setValue(instructions);
    lastCommittedRef.current = instructions;
  }, [instructions]);

  const save = useCallback(
    (nextValue: string) => {
      if (!projectId) return;
      setPending(true);
      setInstructions(projectId, nextValue);
      lastCommittedRef.current = nextValue;
      setPending(false);
    },
    [projectId, setInstructions],
  );

  const onChange = useCallback(
    (newValue: string) => {
      setValue(newValue);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(() => {
        save(newValue);
      }, 800);
    },
    [save],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  return { value, onChange, pending };
}

export function EnvironmentProjectInstructionsSection({
  projectId,
  threadNotes,
  onCopyToThreadNotes,
}: {
  projectId: ProjectId | null;
  threadNotes: string;
  onCopyToThreadNotes: (instructions: string) => void;
}) {
  const autosave = useProjectInstructionsAutosave(projectId);
  const hasInstructions = autosave.value.trim().length > 0;
  const threadNotesEmpty = threadNotes.trim().length === 0;

  const handleCopy = useCallback(() => {
    onCopyToThreadNotes(autosave.value);
    toastManager.add({
      type: "success",
      title: "Copied project instructions to notepad.",
    });
  }, [autosave.value, onCopyToThreadNotes]);

  return (
    <EnvironmentCollapsibleSection label="Project instructions" defaultOpen={hasInstructions}>
      <div className="flex flex-col gap-2 px-2 pb-1">
        <Textarea
          unstyled
          className="relative inline-flex w-full rounded-lg border border-[color:var(--color-border-light)] bg-transparent text-[length:var(--app-font-size-ui,12px)] text-foreground transition-colors has-focus-visible:border-foreground/25 [&_[data-slot=textarea]]:px-3 [&_[data-slot=textarea]]:py-2"
          value={autosave.value}
          onChange={(e) => autosave.onChange(e.target.value)}
          placeholder="Add project-level instructions here (repo links, architecture notes, conventions…)"
          maxLength={THREAD_NOTES_MAX_CHARS}
        />
        {hasInstructions && threadNotesEmpty ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="self-start"
            onClick={handleCopy}
          >
            Copy to thread notepad
          </Button>
        ) : null}
      </div>
    </EnvironmentCollapsibleSection>
  );
}
