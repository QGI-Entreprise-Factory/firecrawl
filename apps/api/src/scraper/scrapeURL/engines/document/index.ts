import { Meta } from "../..";
import { EngineScrapeResult } from "..";
import { config } from "../../../../config";
import { fetchFileToBuffer } from "../utils/downloadFile";
import { DocumentConverter, DocumentType } from "@mendable/firecrawl-rs";
import type { Response } from "undici";
import { DocumentAntibotError } from "../../error";
import { readFile, unlink } from "node:fs/promises";
import { safeMarkdownToHtml } from "../pdf/markdownToHtml";
import {
  convertBufferWithOmniService,
  hasOmniSupportedExtension,
  isOmniSupportedContentType,
} from "./omniConvert";

const converter = new DocumentConverter();

function getDocumentTypeFromUrl(url: string): DocumentType {
  const urlLower = url.toLowerCase();

  // Check for extensions at the end or in the middle (e.g., file.xlsx/hash)
  // Check .docx before .doc to avoid false matches
  if (urlLower.endsWith(".docx") || urlLower.includes(".docx/"))
    return DocumentType.Docx;
  if (urlLower.endsWith(".doc") || urlLower.includes(".doc/"))
    return DocumentType.Doc;
  if (urlLower.endsWith(".odt") || urlLower.includes(".odt/"))
    return DocumentType.Odt;
  if (urlLower.endsWith(".rtf") || urlLower.includes(".rtf/"))
    return DocumentType.Rtf;
  if (
    urlLower.endsWith(".xlsx") ||
    urlLower.endsWith(".xls") ||
    urlLower.includes(".xlsx/") ||
    urlLower.includes(".xls/")
  )
    return DocumentType.Xlsx;

  return DocumentType.Docx; // hope for the best
}

function getDocumentTypeFromContentType(
  contentType: string | null,
): DocumentType | null {
  if (!contentType) return null;

  const ct = contentType.toLowerCase();

  // Check for modern .docx format first (Office Open XML)
  if (
    ct.includes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
  ) {
    return DocumentType.Docx;
  }

  // Legacy .doc format (OLE2/CFB binary format)
  if (ct.includes("application/msword")) {
    return DocumentType.Doc;
  }

  if (ct.includes("application/vnd.oasis.opendocument.text")) {
    return DocumentType.Odt;
  }

  if (ct.includes("application/rtf") || ct.includes("text/rtf")) {
    return DocumentType.Rtf;
  }

  if (
    ct.includes(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ) ||
    ct.includes("application/vnd.ms-excel")
  ) {
    return DocumentType.Xlsx;
  }

  return null;
}

function getContentTypeFromDocumentType(documentType: DocumentType): string {
  switch (documentType) {
    case DocumentType.Docx:
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case DocumentType.Doc:
      return "application/msword";
    case DocumentType.Odt:
      return "application/vnd.oasis.opendocument.text";
    case DocumentType.Rtf:
      return "application/rtf";
    case DocumentType.Xlsx:
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
}

function isValidDocumentContentType(contentType: string | null): boolean {
  if (!contentType) return false;

  const ct = contentType.toLowerCase();
  const validTypes = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/msword",
    "application/rtf",
    "text/rtf",
    "application/vnd.oasis.opendocument.text",
  ];

  return validTypes.some(type => ct.includes(type));
}

export async function scrapeDocument(meta: Meta): Promise<EngineScrapeResult> {
  let response: Response;
  let buffer: Buffer;
  let proxyUsed: "basic" | "stealth" = "basic";
  let tempFilePath: string | null = null;

  const omniConfigured = !!config.OMNI_CONVERT_SERVICE_URL;

  try {
    if (meta.documentPrefetch !== undefined && meta.documentPrefetch !== null) {
      // Use prefetched document
      tempFilePath = meta.documentPrefetch.filePath;
      buffer = await readFile(tempFilePath);

      // Create a mock response object with content-type from prefetch
      const headers = new Headers();
      if (meta.documentPrefetch.contentType) {
        headers.set("Content-Type", meta.documentPrefetch.contentType);
      }

      response = {
        url: meta.documentPrefetch.url ?? meta.rewrittenUrl ?? meta.url,
        status: meta.documentPrefetch.status,
        headers,
      } as Response;

      proxyUsed = meta.documentPrefetch.proxyUsed;
    } else {
      // Fetch the document normally
      const result = await fetchFileToBuffer(
        meta.rewrittenUrl ?? meta.url,
        meta.options.skipTlsVerification,
        {
          headers: meta.options.headers,
          signal: meta.abort.asSignal(),
        },
      );
      response = result.response;
      buffer = result.buffer;

      // Validate content type only when fetching directly (not using prefetch)
      const ct = response.headers.get("Content-Type");
      if (
        ct &&
        !isValidDocumentContentType(ct) &&
        !(omniConfigured && isOmniSupportedContentType(ct))
      ) {
        // if downloaded file wasn't a valid document, throw antibot error
        throw new DocumentAntibotError();
      }
    }

    const contentTypeHeader = response.headers.get("content-type");
    const rustTypeFromContentType =
      getDocumentTypeFromContentType(contentTypeHeader);

    // Types the Rust DocumentConverter doesn't understand go straight to the
    // omni-convert service (when configured). Rust-supported types keep using
    // Rust, falling back to the omni service if Rust conversion throws.
    const omniOnly =
      omniConfigured &&
      rustTypeFromContentType === null &&
      ((contentTypeHeader !== null &&
        isOmniSupportedContentType(contentTypeHeader)) ||
        hasOmniSupportedExtension(response.url));

    if (!omniOnly) {
      const documentType =
        rustTypeFromContentType ?? getDocumentTypeFromUrl(response.url);

      try {
        const html = await converter.convertBufferToHtml(
          new Uint8Array(buffer),
          documentType,
        );

        return {
          url: response.url,
          statusCode: response.status,
          html,
          contentType:
            contentTypeHeader ?? getContentTypeFromDocumentType(documentType),
          proxyUsed,
        };
      } catch (error) {
        if (!omniConfigured) {
          throw error;
        }
        meta.logger.warn(
          "Rust document conversion failed -- falling back to omni-convert service",
          { error },
        );
      }
    }

    // Omni-convert path: the service returns markdown (not HTML), which the
    // engine result supports directly; html is derived for html/rawHtml formats.
    const omniResult = await convertBufferWithOmniService(meta, buffer, {
      contentType: contentTypeHeader ?? undefined,
      sourceUrl: response.url ?? meta.rewrittenUrl ?? meta.url,
    });

    return {
      url: response.url,
      statusCode: response.status,
      html: await safeMarkdownToHtml(
        omniResult.markdown,
        meta.logger,
        meta.id,
      ),
      markdown: omniResult.markdown,
      contentType: contentTypeHeader ?? undefined,
      proxyUsed,
    };
  } finally {
    // Clean up temporary file if it was created by prefetch
    if (tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch (error) {
        // Ignore errors when cleaning up temp files
        meta.logger?.warn("Failed to clean up temporary document file", {
          error,
          tempFilePath,
        });
      }
    }
  }
}

export function documentMaxReasonableTime(meta: Meta): number {
  // Omni-convert covers heavier conversions (audio transcription, archives),
  // which need more headroom than the local Rust converter.
  return config.OMNI_CONVERT_SERVICE_URL ? 60000 : 15000;
}
