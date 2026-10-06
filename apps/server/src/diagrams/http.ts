import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as DiagramService from "./DiagramService.ts";

export const diagramAssetRouteLayer = HttpRouter.add(
  "GET",
  "/api/diagrams/assets/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
    const assetId = url.value.pathname.slice("/api/diagrams/assets/".length);
    const token = url.value.searchParams.get("token");
    if (!token || !assetId) return HttpServerResponse.empty({ status: 404 });
    const diagrams = yield* DiagramService.DiagramService;
    return yield* diagrams.assetRead({ assetId, token }).pipe(
      Effect.map((asset) =>
        HttpServerResponse.uint8Array(asset.bytes, {
          contentType: asset.mimeType,
          headers: {
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        }),
      ),
      Effect.catchTag("DiagramOperationError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
    );
  }),
);
