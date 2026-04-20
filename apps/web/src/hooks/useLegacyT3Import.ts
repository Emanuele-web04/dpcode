import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { useStore } from "../store";

export type LegacyT3ImportOutcome = "cancelled" | "completed" | "failed";

interface ImportLegacyT3StateOptions {
  confirmationLines?: readonly string[];
  skipConfirmation?: boolean;
}

function formatLegacyT3BaseDir(homeDir: string | null | undefined): string {
  if (!homeDir) {
    return "~/.t3 on macOS or %USERPROFILE%\\.t3 on Windows";
  }

  const separator =
    homeDir.endsWith("\\") || homeDir.endsWith("/") ? "" : homeDir.includes("\\") ? "\\" : "/";

  return `${homeDir}${separator}.t3`;
}

export function useLegacyT3Import() {
  const queryClient = useQueryClient();
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [isImportingLegacyT3State, setIsImportingLegacyT3State] = useState(false);

  const defaultLegacyT3BaseDir = useMemo(
    () => formatLegacyT3BaseDir(serverConfigQuery.data?.homeDir),
    [serverConfigQuery.data?.homeDir],
  );

  const importLegacyT3State = useCallback(
    async (options?: ImportLegacyT3StateOptions): Promise<LegacyT3ImportOutcome> => {
      if (isImportingLegacyT3State) {
        return "cancelled";
      }

      const api = readNativeApi() ?? ensureNativeApi();
      if (!options?.skipConfirmation) {
        const confirmed = await api.dialogs.confirm(
          (
            options?.confirmationLines ?? [
              "Import legacy T3 Code data?",
              `Source: ${defaultLegacyT3BaseDir}`,
              "This merges legacy projects and chats into the current DP Code profile.",
              "Existing DP Code chats stay in place and duplicate thread ids are skipped.",
            ]
          ).join("\n"),
        );
        if (!confirmed) {
          return "cancelled";
        }
      }

      setIsImportingLegacyT3State(true);
      try {
        const result = await api.orchestration.importLegacyT3State({});
        const snapshot = await api.orchestration.getSnapshot();
        syncServerReadModel(snapshot);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
        toastManager.add({
          type: "success",
          title: "Legacy T3 data imported",
          description: [
            `${result.importedProjects} projects imported, ${result.mappedProjects} matched`,
            `${result.importedThreads} threads imported, ${result.skippedThreads} skipped`,
            `${result.copiedAttachments} attachments copied`,
          ].join(" | "),
        });
        return "completed";
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Legacy import failed",
          description:
            error instanceof Error ? error.message : "Unable to import T3 Code projects and chats.",
        });
        return "failed";
      } finally {
        setIsImportingLegacyT3State(false);
      }
    },
    [defaultLegacyT3BaseDir, isImportingLegacyT3State, queryClient, syncServerReadModel],
  );

  return {
    defaultLegacyT3BaseDir,
    importLegacyT3State,
    isImportingLegacyT3State,
  };
}
