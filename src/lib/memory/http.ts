import { ProxyResponses } from "@/app/v1/_lib/proxy/responses";

export function buildLocalCapacityResponse(): Response {
  const response = ProxyResponses.buildError(
    429,
    "Local request capacity exhausted; retry later.",
    "local_capacity_exceeded"
  );
  response.headers.set("retry-after", "1");
  return response;
}
