import * as NodeCrypto from "node:crypto";
import { compile } from "tailwindcss";
import { artifactTailwindTheme } from "./artifactTailwindTheme.ts";

const MAX_COMPILERS = 32;

export function createArtifactStyling() {
  const compilers = new Map<string, Promise<Awaited<ReturnType<typeof compile>>>>();
  return async (html: string, candidates: readonly string[] = []) => {
    const styles = Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi), (match) => {
      const style = match[1] ?? "";
      const hasDirectives =
        /@(theme|apply|utility|variant|custom-variant|tailwind|plugin|config|source)\b/.test(
          style,
        ) ||
        /@import\s+["']tailwindcss(?:[/"'])/.test(style) ||
        /type\s*=\s*["']text\/tailwindcss["']/i.test(match[0]);
      return hasDirectives ? style : "";
    }).filter(Boolean);
    const stylesheet = `${artifactTailwindTheme}\n@tailwind utilities;\n${styles.join("\n")}`;
    const key = NodeCrypto.createHash("sha256").update(html).digest("hex");
    let compiler = compilers.get(key);
    if (!compiler) {
      compiler = compile(stylesheet, {
        loadStylesheet: async (id) => {
          if (
            id !== "tailwindcss" &&
            id !== "tailwindcss/theme" &&
            id !== "tailwindcss/theme.css" &&
            id !== "tailwindcss/utilities" &&
            id !== "tailwindcss/utilities.css"
          ) {
            throw new Error("Artifact Tailwind imports must use the pinned theme or utilities.");
          }
          return {
            path: id,
            base: "",
            content: id.includes("utilities")
              ? "@tailwind utilities;"
              : `${artifactTailwindTheme}\n@tailwind utilities;`,
          };
        },
      });
      compilers.set(key, compiler);
      if (compilers.size > MAX_COMPILERS) {
        const oldest = compilers.keys().next().value;
        if (oldest !== undefined) compilers.delete(oldest);
      }
      compiler.catch(() => compilers.delete(key));
    }
    const initial = Array.from(
      html.matchAll(/\bclass\s*=\s*(["'])(.*?)\1/gs),
      (match) => match[2] ?? "",
    ).flatMap((value) => value.split(/\s+/));
    return (await compiler).build([...initial, ...candidates]);
  };
}
