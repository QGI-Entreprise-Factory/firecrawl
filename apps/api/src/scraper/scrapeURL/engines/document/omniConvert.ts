import { z } from "zod";
import { fetch as undiciFetch } from "undici";
import path from "node:path";
import type { Meta } from "../..";
import { config } from "../../../../config";
import { EngineError, UnsupportedFileError } from "../../error";
import { AbortManagerThrownError } from "../../lib/abortManager";

/**
 * Client for the omni-convert service (markitdown HTTP wrapper).
 *
 * Contract:
 *   POST {OMNI_CONVERT_SERVICE_URL}/v1/convert
 *     - body: raw file bytes
 *     - headers: Content-Type (original), X-Source-Url, X-Filename (if known),
 *       optional Authorization: Bearer {OMNI_CONVERT_SERVICE_API_KEY}
 *   200 -> { markdown: string, title: string|null, converter_used: string }
 *   415 -> unsupported format, 422 -> conversion failed
 */

// Content types that the omni-convert service handles and the Rust
// DocumentConverter does not. Everything here was previously rejected with
// UnsupportedFileError (images/audio/video/zip) or fell through to HTML
// scraping (PPTX/EPUB/MSG/IPYNB).
const OMNI_CONTENT_TYPE_PREFIXES = [
  "image/",
  "audio/",
  "video/",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/epub+zip",
  "application/vnd.ms-outlook",
  "application/x-ipynb+json",
];

export function isOmniSupportedContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return OMNI_CONTENT_TYPE_PREFIXES.some(prefix => ct.startsWith(prefix));
}

/** Document-like URL extensions that route straight to the document engine. */
export const OMNI_DOCUMENT_URL_EXTENSIONS = [
  ".pptx",
  ".epub",
  ".msg",
  ".ipynb",
];

const OMNI_MEDIA_URL_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".zip",
  ".mp3",
  ".wav",
  ".m4a",
  ".mp4",
];

export function hasOmniSupportedExtension(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }
  return [...OMNI_DOCUMENT_URL_EXTENSIONS, ...OMNI_MEDIA_URL_EXTENSIONS].some(
    ext => pathname.endsWith(ext) || pathname.includes(ext + "/"),
  );
}

/** Best-effort file extension for a content type handled by the omni service. */
export function omniExtensionForContentType(
  contentType: string,
): string | null {
  const ct = contentType.toLowerCase();
  if (
    ct.startsWith(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )
  ) {
    return "pptx";
  }
  if (ct.startsWith("application/epub+zip")) return "epub";
  if (ct.startsWith("application/vnd.ms-outlook")) return "msg";
  if (ct.startsWith("application/x-ipynb+json")) return "ipynb";
  if (ct.startsWith("application/zip")) return "zip";
  if (
    ct.startsWith("image/") ||
    ct.startsWith("audio/") ||
    ct.startsWith("video/")
  ) {
    const subtype = ct.split("/")[1]?.split(";")[0]?.trim() ?? "";
    const cleaned = subtype.replace(/[^a-z0-9]/g, "");
    return cleaned.length > 0 ? cleaned : null;
  }
  return null;
}

const omniConvertResponseSchema = z.object({
  markdown: z.string(),
  title: z.string().nullable(),
  converter_used: z.string(),
});

type OmniConvertResult = z.infer<typeof omniConvertResponseSchema>;

export async function convertBufferWithOmniService(
  meta: Meta,
  buffer: Buffer,
  options: {
    contentType?: string;
    sourceUrl: string;
  },
): Promise<OmniConvertResult> {
  const baseUrl = config.OMNI_CONVERT_SERVICE_URL;
  if (!baseUrl) {
    throw new EngineError("Omni-convert service is not configured");
  }

  const logger = meta.logger.child({
    method: "convertBufferWithOmniService",
  });

  let filename: string | undefined;
  try {
    const base = path.basename(new URL(options.sourceUrl).pathname);
    filename = base.length > 0 ? base : undefined;
  } catch {
    filename = undefined;
  }

  const startedAt = Date.now();
  logger.info("Omni-convert started", {
    scrapeId: meta.id,
    url: options.sourceUrl,
    contentType: options.contentType,
    sizeBytes: buffer.length,
  });

  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(`${baseUrl.replace(/\/$/, "")}/v1/convert`, {
      method: "POST",
      headers: {
        "Content-Type": options.contentType ?? "application/octet-stream",
        "X-Source-Url": encodeURI(options.sourceUrl),
        ...(filename ? { "X-Filename": filename } : {}),
        ...(config.OMNI_CONVERT_SERVICE_API_KEY
          ? {
              Authorization: `Bearer ${config.OMNI_CONVERT_SERVICE_API_KEY}`,
            }
          : {}),
      },
      body: new Uint8Array(buffer),
      signal: meta.abort.asSignal(),
    });
  } catch (error) {
    if (error instanceof AbortManagerThrownError) throw error;
    throw new EngineError("Omni-convert service request failed", {
      cause: error,
    });
  }

  if (response.status === 415) {
    // The service itself considers the format unsupported -- surface the same
    // user-visible error as before the omni integration existed.
    throw new UnsupportedFileError(
      options.contentType ?? "unknown content type",
    );
  }

  if (response.status === 422) {
    throw new EngineError(
      "Omni-convert service failed to convert the file (422)",
    );
  }

  if (response.status !== 200) {
    throw new EngineError(
      `Omni-convert service returned unexpected status ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new EngineError("Omni-convert service returned malformed JSON", {
      cause: error,
    });
  }

  const parsed = omniConvertResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new EngineError(
      "Omni-convert service response did not match the expected schema",
      { cause: parsed.error },
    );
  }

  logger.info("Omni-convert completed", {
    scrapeId: meta.id,
    url: options.sourceUrl,
    durationMs: Date.now() - startedAt,
    converterUsed: parsed.data.converter_used,
    markdownLength: parsed.data.markdown.length,
  });

  return parsed.data;
}
