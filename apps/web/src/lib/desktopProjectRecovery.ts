import type { OrchestrationReadModel } from "@t3tools/contracts";

export function hasLiveThreadsWithMissingProjects(snapshot: OrchestrationReadModel): boolean {
  const liveProjectIds = new Set(
    snapshot.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => project.id),
  );

  return snapshot.threads.some(
    (thread) => thread.deletedAt === null && !liveProjectIds.has(thread.projectId),
  );
}
