/**
 * Kling Official Provider for Generate API Route
 *
 * Implements JWT auth and async task polling for Kling official API.
 */

import crypto from "crypto";
import { GenerationInput, GenerationOutput } from "@/lib/providers/types";

const DEFAULT_BASE_URL = "https://api-singapore.klingai.com";
const MAX_WAIT_TIME_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

type KlingStatus = "submitted" | "processing" | "succeed" | "failed" | string;

interface KlingCreateResponse {
  code?: number;
  message?: string;
  data?: {
    task_id?: string;
    task_status?: KlingStatus;
  };
  request_id?: string;
}

interface KlingStatusResponse {
  code?: number;
  message?: string;
  data?: {
    task_id?: string;
    task_status?: KlingStatus;
    task_status_msg?: string;
    task_result?: {
      videos?: Array<{ url?: string; duration?: string }>; // Kling returns video URLs
    };
  };
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createJwt(accessKey: string, secretKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: accessKey,
      exp: now + 1800,
      nbf: now - 5,
    })
  );
  const unsigned = `${header}.${payload}`;
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(unsigned)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${unsigned}.${signature}`;
}

function normalizeBase64(input: string): string {
  if (input.startsWith("data:")) {
    const matches = input.match(/^data:[^;]+;base64,(.+)$/);
    if (matches) return matches[1];
  }
  return input;
}

function getModelName(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes("v1-6")) return "kling-v1-6";
  if (lower.includes("v2-master")) return "kling-v2-master";
  if (lower.includes("v2-6")) return "kling-v2-6";
  if (lower.includes("v1")) return "kling-v1";
  return "kling-v2-6";
}

function pickImageInput(input: GenerationInput): string | null {
  const dynamic = input.dynamicInputs || {};
  const candidates: Array<string | string[] | undefined> = [
    dynamic.image,
    dynamic.image_url,
    dynamic.image_urls,
    dynamic.input_image,
    dynamic.images,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      const first = candidate.find((v) => typeof v === "string" && v.length > 0);
      if (first) return first;
    } else if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  if (input.images && input.images.length > 0) {
    return input.images[0];
  }

  return null;
}

async function pollKlingTask(
  requestId: string,
  baseUrl: string,
  endpoint: "text2video" | "image2video",
  taskId: string,
  accessKey: string,
  secretKey: string
): Promise<{ success: boolean; url?: string; error?: string }> {
  const startTime = Date.now();
  let lastStatus: string | null = null;

  while (true) {
    if (Date.now() - startTime > MAX_WAIT_TIME_MS) {
      return { success: false, error: "Generation timed out after 10 minutes" };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const jwt = createJwt(accessKey, secretKey);
    const statusUrl = `${baseUrl}/v1/videos/${endpoint}/${encodeURIComponent(taskId)}`;

    const response = await fetch(statusUrl, {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    });

    if (!response.ok) {
      return { success: false, error: `Failed to poll status: ${response.status}` };
    }

    const result = (await response.json()) as KlingStatusResponse;
    const status = result.data?.task_status || "";

    if (status && status !== lastStatus) {
      console.log(`[API:${requestId}] Kling task status: ${status}`);
      lastStatus = status;
    }

    if (status === "succeed" || status === "success") {
      const url = result.data?.task_result?.videos?.[0]?.url;
      if (!url) {
        return { success: false, error: "No video URL returned by Kling" };
      }
      return { success: true, url };
    }

    if (status === "failed") {
      return {
        success: false,
        error: result.data?.task_status_msg || "Generation failed",
      };
    }
  }
}

export async function generateWithKling(
  requestId: string,
  accessKey: string,
  secretKey: string,
  input: GenerationInput
): Promise<GenerationOutput> {
  const baseUrl = process.env.KLING_API_BASE || DEFAULT_BASE_URL;
  const modelName = getModelName(input.model.id);
  const isImageToVideo = input.model.capabilities.includes("image-to-video");
  const endpoint: "text2video" | "image2video" = isImageToVideo ? "image2video" : "text2video";

  const payload: Record<string, unknown> = {
    model_name: modelName,
    prompt: input.prompt || "",
  };

  if (input.parameters) {
    Object.assign(payload, input.parameters);
  }

  if (input.dynamicInputs) {
    const negativePrompt = input.dynamicInputs.negative_prompt;
    if (typeof negativePrompt === "string") {
      payload.negative_prompt = negativePrompt;
    }
  }

  if (isImageToVideo) {
    const imageValue = pickImageInput(input);
    if (!imageValue) {
      return { success: false, error: "Image input is required for Kling image-to-video" };
    }
    payload.image = imageValue.startsWith("http") ? imageValue : normalizeBase64(imageValue);
  }

  console.log(
    `[API:${requestId}] Kling generation - Model: ${modelName}, Mode: ${endpoint}`
  );

  const jwt = createJwt(accessKey, secretKey);
  const createUrl = `${baseUrl}/v1/videos/${endpoint}`;
  const createResponse = await fetch(createUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    return { success: false, error: `Kling API error: ${createResponse.status} ${errorText}` };
  }

  const createResult = (await createResponse.json()) as KlingCreateResponse;
  const taskId = createResult.data?.task_id;
  if (!taskId) {
    return { success: false, error: "Kling API did not return task_id" };
  }

  const pollResult = await pollKlingTask(
    requestId,
    baseUrl,
    endpoint,
    taskId,
    accessKey,
    secretKey
  );

  if (!pollResult.success || !pollResult.url) {
    return { success: false, error: pollResult.error || "Generation failed" };
  }

  return {
    success: true,
    outputs: [
      {
        type: "video",
        data: "",
        url: pollResult.url,
      },
    ],
  };
}
