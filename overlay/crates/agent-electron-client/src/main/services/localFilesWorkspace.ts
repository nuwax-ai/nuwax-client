import * as fs from "node:fs";
import * as path from "node:path";
import { findNormalProjectWorkspaceByProjectId, findProjectWorkspaceByProjectId, resolveAgentProjectDir } from "./workspacePaths";

export interface WorkspaceLookupInput {
  cId: string; workspacePath?: string; projectId?: string; serviceType?: string; userId?: string;
}
export interface WorkspaceLookupDeps {
  base: string;
  getSessionDirectory(id: string): string | null | Promise<string | null>;
}
function existingDirectory(candidate: string | null | undefined): string | null {
  if (!candidate || !path.isAbsolute(candidate)) return null;
  try { return fs.statSync(candidate).isDirectory() ? fs.realpathSync(candidate) : null; }
  catch { return null; }
}

/** Never substitutes HOME/engine-wide workspace for a particular conversation cwd. */
export async function resolveLocalFilesWorkspace(input: WorkspaceLookupInput, deps: WorkspaceLookupDeps): Promise<string | null> {
  const ids = [...new Set([input.cId, input.projectId].filter((id): id is string => !!id))];
  const sessionDirs = new Set<string>();
  for (const id of ids) {
    const cwd = existingDirectory(await deps.getSessionDirectory(id));
    if (cwd) sessionDirs.add(cwd);
  }
  if (sessionDirs.size > 1) return null;
  if (sessionDirs.size === 1) return [...sessionDirs][0];
  const explicit = existingDirectory(input.workspacePath);
  if (explicit) return explicit;
  const normal = input.serviceType === "computer-normal-project" || input.serviceType === "normalProject";
  const id = normal ? input.projectId : input.cId;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  if (input.userId && /^[A-Za-z0-9_-]+$/.test(input.userId)) {
    const exact = existingDirectory(resolveAgentProjectDir(deps.base, input.userId, id, normal ? "computer-normal-project" : input.serviceType));
    if (exact) return exact;
  }
  const find = normal ? findNormalProjectWorkspaceByProjectId : findProjectWorkspaceByProjectId;
  return existingDirectory(find(deps.base, id, candidate => !!existingDirectory(candidate)) ?? undefined);
}
