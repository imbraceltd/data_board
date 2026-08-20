/**
 * Link Preview Controller
 * Fetches a URL and extracts title / description / image / canonical metadata
 * Mirrors the legacy backend handler at POST /v1/link_preview/getWebsiteInfo
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as cheerio from "cheerio";
import axios from "axios";
import logger from "../../infrastructure/logging/logger";

export const linkPreviewController = new Hono();

const getWebsiteInfoSchema = z.object({
  url: z.string().url(),
});

linkPreviewController.post(
  "/getWebsiteInfo",
  zValidator("json", getWebsiteInfoSchema),
  async (c) => {
    try {
      const { url } = c.req.valid("json");

      const response = await axios.get(url, { timeout: 10000 });
      const $ = cheerio.load(response.data);

      let title = $("head title").text();
      let description = $('meta[name="description"]').attr("content");
      let imageUrl = $('meta[property="og:image"]').attr("content");
      const canonicalUrl = $('link[rel="canonical"]').attr("href");

      if (!title) {
        title = $('meta[property="og:title"]').attr("content") || "";
      }
      if (!description) {
        description = $('meta[property="og:description"]').attr("content");
      }
      if (!imageUrl) {
        imageUrl = $('meta[name="twitter:image"]').attr("content");
      }
      if (!imageUrl) {
        imageUrl = $('link[rel="shortcut icon"]').attr("href");
      }
      if (!imageUrl) {
        imageUrl = $('link[rel="apple-touch-icon"]').attr("href");
      }

      return c.json({
        success: true,
        message: "Infomation retrieved",
        data: {
          title: title || null,
          description: description || null,
          imageUrl: imageUrl || null,
          canonicalUrl: canonicalUrl || null,
        },
      });
    } catch (err) {
      logger.warn("link_preview/getWebsiteInfo failed", {
        error: (err as Error).message,
      });
      return c.body(null, 204);
    }
  },
);
