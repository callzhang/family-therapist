import { IntakeError, submitConfirmedExpression } from "../../../src/server/intake.mjs";
import { intakeErrorResponse, readBoundedJson } from "../../../src/server/intake-http.mjs";
import { HttpError, memberContext, routeError } from "../../../src/server/member-context";

function respond(error: unknown): Response {
  if (error instanceof IntakeError) return intakeErrorResponse(error);
  if (error instanceof HttpError) return routeError(error);
  console.error("Expression intake failed", error);
  return Response.json({ error: "The confirmed expression could not be accepted." }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const context = await memberContext();
    const command = await readBoundedJson(request);
    const receipt = await submitConfirmedExpression({ db: context.db, scope: context.scope, command });
    return Response.json(receipt, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return respond(error); }
}
