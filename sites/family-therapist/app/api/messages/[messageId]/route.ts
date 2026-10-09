import { IntakeError, getExpressionReceipt } from "../../../../src/server/intake.mjs";
import { intakeErrorResponse, receiptNotFoundResponse } from "../../../../src/server/intake-http.mjs";
import { HttpError, memberContext, routeError } from "../../../../src/server/member-context";

function respond(error: unknown): Response {
  if (error instanceof IntakeError) return intakeErrorResponse(error);
  if (error instanceof HttpError) return routeError(error);
  console.error("Expression receipt lookup failed", error);
  return Response.json({ error: "The expression receipt could not be read." }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ messageId: string }> }): Promise<Response> {
  try {
    const context = await memberContext();
    const { messageId } = await params;
    const receipt = await getExpressionReceipt({ db: context.db, scope: context.scope, messageId });
    if (!receipt) return receiptNotFoundResponse();
    return Response.json(receipt, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return respond(error); }
}
