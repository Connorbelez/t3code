import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  ComposerContextId,
  DiagramId,
  EnvironmentId,
  ProjectId,
  type DiagramMetadata,
  type DiagramReadResult,
  type DiagramContextRecord,
  type DiagramPreviewResult,
} from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { diagramCommands } from "../../state/diagrams";
import { insertComposerDraftContext } from "../../state/use-composer-drafts";
import { uuidv4 } from "../../lib/uuid";

export type DiagramRouteParams = {
  environmentId: string;
  projectId: string;
  diagramId?: string;
  draftKey?: string;
  newTask?: boolean;
  returnSteps?: number;
};

export function DiagramScreen({ route }: StaticScreenProps<DiagramRouteParams>) {
  const navigation = useNavigation();
  const { environmentId, projectId, diagramId, draftKey } = route.params;
  const [library, setLibrary] = useState<ReadonlyArray<DiagramMetadata>>([]);
  const [document, setDocument] = useState<DiagramReadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<DiagramPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (diagramId) {
          const result = await runAtomCommand(
            appAtomRegistry,
            diagramCommands.read,
            {
              environmentId: EnvironmentId.make(environmentId),
              input: { projectId: ProjectId.make(projectId), diagramId: DiagramId.make(diagramId) },
            },
            { reportFailure: false },
          );
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          if (active) setDocument(result.value);
          const cached = await runAtomCommand(
            appAtomRegistry,
            diagramCommands.preview,
            {
              environmentId: EnvironmentId.make(environmentId),
              input: { projectId: ProjectId.make(projectId), diagramId: DiagramId.make(diagramId) },
            },
            { reportFailure: false },
          );
          if (active && cached._tag === "Success") setPreview(cached.value);
        } else {
          const result = await runAtomCommand(
            appAtomRegistry,
            diagramCommands.list,
            {
              environmentId: EnvironmentId.make(environmentId),
              input: { projectId: ProjectId.make(projectId) },
            },
            { reportFailure: false },
          );
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          if (active) setLibrary(result.value);
        }
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : "Diagram unavailable.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [environmentId, projectId, diagramId]);
  const attach = () => {
    const page = document?.structure.pages[0];
    if (!document || !page || !draftKey) return;
    const record: DiagramContextRecord = {
      version: 1,
      kind: "diagram",
      contextId: ComposerContextId.make(`diagram_${uuidv4()}`),
      label: document.diagram.name,
      payload: {
        environmentId: EnvironmentId.make(environmentId),
        projectId: document.diagram.projectId,
        diagramId: document.diagram.id,
        scope: { kind: "diagram", pageId: page.id },
      },
    };
    if (
      insertComposerDraftContext(draftKey, {
        text: formatComposerContextReference(record),
        context: { version: 1, records: [record] },
      })
    )
      navigation.dispatch(StackActions.pop(route.params.returnSteps ?? 1));
  };
  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 20, gap: 16 }}>
      {loading ? <Text className="text-foreground-muted">Loading diagrams…</Text> : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-foreground">
          {error}
        </Text>
      ) : null}
      {!diagramId
        ? library.map((diagram) => (
            <Pressable
              key={diagram.id}
              accessibilityRole="button"
              onPress={() =>
                navigation.dispatch(
                  StackActions.push(route.params.newTask === true ? "NewTaskDiagram" : "Diagram", {
                    environmentId,
                    projectId,
                    diagramId: diagram.id,
                    newTask: route.params.newTask,
                    returnSteps: 2,
                    ...(draftKey ? { draftKey } : {}),
                  }),
                )
              }
              className="rounded-xl border border-border p-4"
            >
              <Text className="text-foreground">{diagram.name}</Text>
            </Pressable>
          ))
        : null}
      {!diagramId && library.length === 0 && !error && !loading ? (
        <Text className="text-foreground-muted">
          No diagrams in this project. Create one in Canvas on web or desktop.
        </Text>
      ) : null}
      {document ? (
        <>
          <Text className="text-xl font-semibold text-foreground">{document.diagram.name}</Text>
          <Text className="text-foreground-muted">
            Revision {document.diagram.revision}. View only.
          </Text>
          {preview?.capture?.mimeType === "image/png" ? (
            <View className="gap-2">
              <Image
                accessibilityLabel={`Cached diagram preview from revision ${preview.capture.revision}`}
                resizeMode="contain"
                source={{
                  uri: `data:${preview.capture.mimeType};base64,${preview.capture.base64}`,
                }}
                style={{
                  width: "100%",
                  height: Math.min(480, Math.max(180, preview.capture.height)),
                }}
              />
              <Text className="text-foreground-muted">
                {preview.stale ? "Stale cached preview" : "Cached preview"}. Revision{" "}
                {preview.capture.revision}. {preview.capture.scope.kind} scope.
              </Text>
            </View>
          ) : (
            <Text className="text-foreground-muted">
              {preview?.capture
                ? "This cached preview format cannot be displayed on mobile."
                : "No cached preview is available."}
            </Text>
          )}
          <Text className="text-foreground-muted">
            A fresh image is prepared when this reference is sent. Without an editor host, the agent
            receives current structure with image unavailable.
          </Text>
          {draftKey ? (
            <Pressable
              accessibilityRole="button"
              onPress={attach}
              className="rounded-xl bg-accent p-4"
            >
              <Text className="text-center text-foreground">Attach diagram</Text>
            </Pressable>
          ) : null}
          {document.structure.pages.map((page) => (
            <View key={page.id} className="gap-2">
              <Text className="font-semibold text-foreground">
                {page.name} ({page.shapeCount} shapes)
              </Text>
              {document.structure.shapes
                .filter((shape) => shape.pageId === page.id)
                .map((shape) => (
                  <Text key={shape.id} className="text-foreground">
                    {shape.type}
                    {shape.label ? ` · ${shape.label}` : ""}
                    {shape.locked ? " · Locked" : ""}
                  </Text>
                ))}
            </View>
          ))}
          {document.structure.truncated ? (
            <Text className="text-foreground-muted">
              Showing a bounded summary of {document.structure.totalShapes} shapes.
            </Text>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
