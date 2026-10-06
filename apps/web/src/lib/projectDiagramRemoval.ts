import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DIAGRAM_PROTOCOL_VERSION, DIAGRAM_SDK_VERSION } from "@t3tools/contracts";
import { requestConfirmDialog } from "~/confirmDialog";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { createDiagramApi } from "~/components/diagrams/diagramApi";

type ProjectTarget = { environmentId: EnvironmentId; id: ProjectId };

export async function confirmProjectRemoval(
  message: string,
  projects: readonly ProjectTarget[],
  options?: { onlyWhenDiagrams: boolean },
) {
  const supported = projects.filter(({ environmentId }) => {
    const capability = appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))
      ?.serverConfig?.environment.capabilities.diagrams;
    return (
      capability?.protocolVersion === DIAGRAM_PROTOCOL_VERSION &&
      capability.sdkVersion === DIAGRAM_SDK_VERSION
    );
  });
  const counts = await Promise.all(
    supported.map(async (project) => {
      const api = createDiagramApi(appAtomRegistry, project.environmentId);
      return { project, api, counts: await api.count({ projectId: project.id }) };
    }),
  );
  const active = counts.reduce((total, item) => total + item.counts.active, 0);
  const archived = counts.reduce((total, item) => total + item.counts.archived, 0);
  const hasDiagrams = active + archived > 0;
  if (!hasDiagrams && options?.onlyWhenDiagrams) return true;
  const warning = hasDiagrams
    ? `\nThis permanently deletes ${active} active and ${archived} archived diagram${active + archived === 1 ? "" : "s"} and their saved assets. Export diagrams first if you want to keep them.`
    : "";
  const fullMessage = `${message}${warning}`;
  const action = hasDiagrams
    ? {
        label: "Export diagrams",
        run: async () => {
          const { default: JSZip } = await import("jszip");
          const zip = new JSZip();
          for (const { project, api } of counts) {
            const diagrams = await api.list({ projectId: project.id, includeArchived: true });
            for (const diagram of diagrams) {
              const document = await api.export({ projectId: project.id, diagramId: diagram.id });
              zip.file(
                `${project.environmentId}/${project.id}/${diagram.id}.tldr`,
                JSON.stringify(document),
              );
            }
          }
          const blob = await zip.generateAsync({ type: "blob" });
          const url = URL.createObjectURL(blob);
          try {
            const link = document.createElement("a");
            link.href = url;
            link.download = "t3-diagrams.zip";
            link.click();
          } finally {
            URL.revokeObjectURL(url);
          }
        },
      }
    : undefined;
  return await (requestConfirmDialog(fullMessage, {
    variant: "destructive",
    ...(action === undefined ? {} : { action }),
  }) ??
    readLocalApi()?.dialogs.confirm(fullMessage, { variant: "destructive" }) ??
    Promise.resolve(false));
}
