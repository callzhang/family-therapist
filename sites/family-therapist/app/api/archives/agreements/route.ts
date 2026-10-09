import { memberContext, routeError, HttpError } from "../../../../src/server/member-context";
import { agreementArchiveResponse } from "../../../../src/server/agreement-archive-route";

export async function GET(request: Request): Promise<Response> {
  try {
    const context = await memberContext();
    const bucket = (await import("cloudflare:workers")).env.BUCKET;
    if (!bucket) throw new HttpError(503, "档案下载暂时不可用，请稍后重试。");
    return await agreementArchiveResponse(context, request, bucket);
  } catch (error) { return routeError(error); }
}
