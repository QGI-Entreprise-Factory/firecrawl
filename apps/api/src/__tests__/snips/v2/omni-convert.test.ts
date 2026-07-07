import { describeIf } from "../lib";
import {
  scrape,
  scrapeRaw,
  scrapeTimeout,
  idmux,
  Identity,
} from "./lib";

// The omni-convert service (markitdown HTTP wrapper) converts formats the
// crawler used to reject (PPTX, images, audio, ZIP, EPUB, MSG, IPYNB, ...)
// into markdown. It is not deployed in CI yet, so the happy-path tests skip
// cleanly unless OMNI_CONVERT_SERVICE_URL is configured.
const HAS_OMNI_CONVERT = !!process.env.OMNI_CONVERT_SERVICE_URL;

const PPTX_URL =
  "https://scholar.harvard.edu/files/torman_personal/files/samplepptx.pptx";
const PNG_URL = "https://www.w3.org/Icons/w3c_home.png";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "omni-convert",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describeIf(!process.env.TEST_SUITE_SELF_HOSTED && HAS_OMNI_CONVERT)(
  "Omni-convert routing (service configured)",
  () => {
    it.concurrent(
      "converts a PPTX URL to markdown",
      async () => {
        const response = await scrape(
          {
            url: PPTX_URL,
            formats: ["markdown"],
            timeout: scrapeTimeout,
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.markdown!.trim().length).toBeGreaterThan(0);
        // PPTX must not fall through to the HTML pipeline returning raw
        // ZIP bytes ("PK...") as content
        expect(response.markdown!.startsWith("PK")).toBe(false);
      },
      scrapeTimeout * 2,
    );

    it.concurrent(
      "converts a PNG URL to markdown",
      async () => {
        const response = await scrape(
          {
            url: PNG_URL,
            formats: ["markdown"],
            timeout: scrapeTimeout,
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(typeof response.markdown).toBe("string");
      },
      scrapeTimeout * 2,
    );
  },
);

describeIf(!process.env.TEST_SUITE_SELF_HOSTED && !HAS_OMNI_CONVERT)(
  "Omni-convert routing (service not configured)",
  () => {
    it.concurrent(
      "still rejects an image URL with SCRAPE_UNSUPPORTED_FILE_ERROR",
      async () => {
        const raw = await scrapeRaw(
          {
            url: PNG_URL,
            formats: ["markdown"],
            timeout: scrapeTimeout,
          },
          identity,
        );

        expect(raw.statusCode).not.toBe(200);
        expect(raw.body.success).toBe(false);
        expect(raw.body.code).toBe("SCRAPE_UNSUPPORTED_FILE_ERROR");
      },
      scrapeTimeout * 2,
    );
  },
);
