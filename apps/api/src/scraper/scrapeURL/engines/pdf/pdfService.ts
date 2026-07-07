import { Meta } from "../..";
import { config } from "../../../../config";
import { robustFetch } from "../../lib/fetch";
import { safeMarkdownToHtml } from "./markdownToHtml";
import { z } from "zod";
import path from "node:path";
import { FormData } from "undici";
import type { PDFProcessorResult } from "./types";

/**
 * Client for the external PDF service (structure-aware opendataloader-pdf
 * HTTP wrapper).
 *
 * Contract:
 *   POST {PDF_SERVICE_URL}/v1/convert
 *     - multipart/form-data, field `file` = the PDF bytes (filename included)
 *     - optional Authorization: Bearer {PDF_SERVICE_API_KEY}
 *   200 -> { markdown: string, json: object|null, processing_time_ms: number }
 */
const pdfServiceResponseSchema = z.object({
  markdown: z.string(),
  json: z.unknown().nullable(),
  processing_time_ms: z.number(),
});

export async function scrapePDFWithPdfService(
  meta: Meta,
  tempFilePath: string,
  pdfBuffer: Buffer,
): Promise<PDFProcessorResult> {
  const logger = meta.logger;

  meta.abort.throwIfAborted();

  const startedAt = Date.now();
  logger.info("PDF service started", {
    scrapeId: meta.id,
    url: meta.rewrittenUrl ?? meta.url,
    fileSizeBytes: pdfBuffer.length,
  });

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(pdfBuffer)], { type: "application/pdf" }),
    path.basename(tempFilePath) + ".pdf",
  );

  const resp = await robustFetch({
    url: `${config.PDF_SERVICE_URL}/v1/convert`,
    method: "POST",
    headers: config.PDF_SERVICE_API_KEY
      ? { Authorization: `Bearer ${config.PDF_SERVICE_API_KEY}` }
      : undefined,
    body: form,
    logger: logger.child({
      method: "scrapePDFWithPdfService/robustFetch",
    }),
    schema: pdfServiceResponseSchema,
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  logger.info("PDF service completed", {
    scrapeId: meta.id,
    url: meta.rewrittenUrl ?? meta.url,
    durationMs: Date.now() - startedAt,
    serviceProcessingTimeMs: resp.processing_time_ms,
    markdownLength: resp.markdown.length,
    hasStructuredJson: resp.json !== null && resp.json !== undefined,
  });

  return {
    markdown: resp.markdown,
    html: await safeMarkdownToHtml(resp.markdown, logger, meta.id),
    ...(resp.json !== null && resp.json !== undefined
      ? { structuredJson: resp.json }
      : {}),
  };
}
