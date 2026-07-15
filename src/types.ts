export type ImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";
export type ImageQuality = "auto" | "low" | "medium" | "high";
export type SaveMode = "auto" | "none" | "project" | "global";

export interface GenerateImageRequest {
  prompt: string;
  referencedImagePaths?: string[];
  outputPath?: string;
  save?: SaveMode;
  size?: ImageSize;
  quality?: ImageQuality;
}

export interface GeneratedImageData {
  base64: string;
  created?: number;
  quality?: string;
  size?: string;
}

export interface HttpRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HttpTransport {
  send(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
}
