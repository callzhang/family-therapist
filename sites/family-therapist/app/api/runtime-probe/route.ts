import { apiMemberContext } from "../../../src/server/api-member-context";
import { HttpError, routeError } from "../../../src/server/member-context";

const probeDurationMs = 75_000;
const keepaliveIntervalMs = 5_000;

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await apiMemberContext(request);

    const startedAt = Date.now();
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ event: "started", elapsed_ms: 0 })}\n`));
        timer = setInterval(() => {
          const elapsed = Date.now() - startedAt;
          if (elapsed >= probeDurationMs) {
            controller.enqueue(encoder.encode(`${JSON.stringify({ event: "done", elapsed_ms: elapsed })}\n`));
            controller.close();
            if (timer) clearInterval(timer);
            timer = undefined;
            return;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify({ event: "keepalive", elapsed_ms: elapsed })}\n`));
        }, keepaliveIntervalMs);
      },
      cancel() {
        if (timer) clearInterval(timer);
        timer = undefined;
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store, no-transform",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof HttpError) return routeError(error);
    return Response.json({ code: "runtime_probe_unavailable", error: "运行时探针暂时不可用。" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
